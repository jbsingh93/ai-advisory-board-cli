/**
 * skill-creator invocation — Phase 5 Chunk 4. Per docs/development/SKILL_CREATOR.md §8.
 *
 * Headless spawn pattern:
 *   claude -p "<user msg>" --append-system-prompt-file <skill-creator/SKILL.md>
 *          --allowedTools Write,Edit,Read,Glob,Bash
 *          --output-format stream-json
 *          --cwd <runId workspace tempdir>
 *
 * We stream tool-use events back to the caller for live progress, and at
 * end-of-run inventory the workspace for the emitted SKILL.md package.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runClaude, type ClaudeStreamEvent } from '../../llm/claude-code-runner.js';
import { ModelError } from '../errors.js';
import { logger } from '../logger.js';
import { resolveSkillCreator } from './resolve-skill-creator.js';
import { renderUserMessage, type SkillCreatorBrief } from './build-brief.js';
import { UserError } from '../errors.js';

export interface InvokeSkillCreatorOptions {
  brief: SkillCreatorBrief;
  workspaceDir: string;
  /** Absolute path to skill-creator's SKILL.md — pre-resolved by caller. */
  skillCreatorPath?: string;
  /** Default `sonnet` (skill-creator is good at authoring at sonnet quality). */
  modelOverride?: string;
  /** Default 20 min. */
  timeoutMs?: number;
  /** Project root to walk for skill-creator if not pre-resolved. */
  projectRoot?: string;
  /** Streaming event sink. */
  onEvent?: (event: ClaudeStreamEvent) => void;
  /** Telemetry sink — receives one JSONL-shaped object per stream event. */
  onTelemetry?: (line: Record<string, unknown>) => void;
  /** External abort signal — kills the spawn. */
  signal?: AbortSignal;
}

export interface EmittedFile {
  /** Relative path within the workspace, POSIX-style. */
  path: string;
  content: string;
  sizeBytes: number;
}

export interface InvokeSkillCreatorResult {
  files: EmittedFile[];
  /** True if SKILL.md was emitted. */
  hasSkillMd: boolean;
  /** True if `SKILL_CREATOR_DONE:` sentinel was printed in stdout. */
  sentinelObserved: boolean;
  costUsd: number;
  durationMs: number;
  /** Tool-call count (best-effort — counted from stream events). */
  toolCallCount: number;
  /** Raw stdout for debug. */
  stdoutTail: string;
}

export async function invokeSkillCreator(opts: InvokeSkillCreatorOptions): Promise<InvokeSkillCreatorResult> {
  const skillCreatorPath = opts.skillCreatorPath ?? resolveSkillCreator({ projectRoot: opts.projectRoot })?.path;
  if (!skillCreatorPath) {
    throw new UserError(
      'skill-creator skill not installed',
      'Run `aab init --install-skill-creator` for installation instructions, or `/plugin install skill-creator@claude-plugins-official` inside Claude Code.',
    );
  }

  // Ensure the per-run workspace exists.
  mkdirSync(opts.workspaceDir, { recursive: true });

  const userMessage = renderUserMessage(opts.brief);
  let toolCallCount = 0;
  let sentinelObserved = false;
  let stdoutSeen = '';

  const onEvent = (evt: ClaudeStreamEvent): void => {
    opts.onTelemetry?.(evt as unknown as Record<string, unknown>);
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const part of evt.message.content) {
        if (part.type === 'tool_use') toolCallCount++;
        if (part.type === 'text' && part.text) {
          stdoutSeen += part.text + '\n';
          if (part.text.includes(`SKILL_CREATOR_DONE: ${opts.brief.installTarget.skillName}`)) {
            sentinelObserved = true;
          }
        }
      }
    }
    if (evt.type === 'result' && typeof evt.result === 'string') {
      stdoutSeen += evt.result + '\n';
      if (evt.result.includes(`SKILL_CREATOR_DONE: ${opts.brief.installTarget.skillName}`)) {
        sentinelObserved = true;
      }
    }
    opts.onEvent?.(evt);
  };

  let costUsd = 0;
  let durationMs = 0;
  try {
    const result = await runClaude({
      prompt: userMessage,
      appendSystemPromptFile: skillCreatorPath,
      allowedTools: ['Write', 'Edit', 'Read', 'Glob', 'Bash'],
      cwd: opts.workspaceDir,
      outputFormat: 'stream-json',
      model: opts.modelOverride ?? 'sonnet',
      timeoutMs: opts.timeoutMs ?? 20 * 60_000,
      signal: opts.signal,
      onEvent,
    });
    costUsd = result.json?.cost_usd ?? 0;
    durationMs = result.durationMs;
    if (typeof result.json?.result === 'string') {
      stdoutSeen += result.json.result + '\n';
      if (result.json.result.includes(`SKILL_CREATOR_DONE: ${opts.brief.installTarget.skillName}`)) {
        sentinelObserved = true;
      }
    }
  } catch (err) {
    throw new ModelError(
      `skill-creator invocation failed: ${err instanceof Error ? err.message : String(err)}`,
      'Check that --append-system-prompt-file is supported by your `claude` CLI version. Re-run with --debug.',
    );
  }

  // Inventory the workspace.
  const files = walkWorkspace(opts.workspaceDir);
  const hasSkillMd = files.some((f) => f.path === 'SKILL.md' || /^SKILL\.md$/i.test(f.path));

  logger.debug('[skill-creator] run done', {
    files: files.length,
    hasSkillMd,
    sentinelObserved,
    toolCallCount,
    costUsd,
    durationMs,
  });

  return {
    files,
    hasSkillMd,
    sentinelObserved,
    costUsd,
    durationMs,
    toolCallCount,
    stdoutTail: stdoutSeen.slice(-2000),
  };
}

/**
 * Recursively walk the workspace dir and collect every regular file as an
 * EmittedFile. Skips hidden dirs and node_modules to stay sane on
 * accidental nesting.
 */
export function walkWorkspace(root: string): EmittedFile[] {
  const out: EmittedFile[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue;
      const full = join(dir, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        try {
          const content = readFileSync(full, 'utf8');
          const relPath = relative(root, full).split(/[\\/]/).join('/');
          out.push({ path: relPath, content, sizeBytes: st.size });
        } catch {
          // Binary or unreadable — skip silently.
        }
      }
    }
  }
  walk(root);
  return out;
}

/**
 * Stub mode for tests + offline smoke runs — writes a canned SKILL.md
 * matching the brief into the workspace and reports as if skill-creator
 * ran successfully. Useful when validating the orchestrator without
 * burning real tokens.
 */
export function stubSkillCreatorRun(opts: InvokeSkillCreatorOptions): InvokeSkillCreatorResult {
  mkdirSync(opts.workspaceDir, { recursive: true });
  const skillMd = stubSkillMd(opts.brief);
  writeFileSync(join(opts.workspaceDir, 'SKILL.md'), skillMd);
  const files = walkWorkspace(opts.workspaceDir);
  return {
    files,
    hasSkillMd: true,
    sentinelObserved: true,
    costUsd: 0,
    durationMs: 1,
    toolCallCount: 1,
    stdoutTail: `SKILL_CREATOR_DONE: ${opts.brief.installTarget.skillName}`,
  };
}

function stubSkillMd(brief: SkillCreatorBrief): string {
  const tools = brief.capabilityProfile.grantedTools;
  const proposal = brief.skillPlannerProposal;
  return [
    '---',
    `name: ${brief.installTarget.skillName}`,
    `description: ${proposal.triggerLanguage ?? proposal.skillSummary}`,
    'allowed-tools:',
    ...tools.map((t) => `  - ${t}`),
    'model: inherit',
    '---',
    '',
    `# ${proposal.skillName}`,
    '',
    proposal.skillSummary,
    '',
    '## Integrations',
    ...proposal.integrations.map(
      (i) => `- ${i.name} (${i.invocationHint.kind})${i.invocationHint.snippet ? '\n  ```\n  ' + i.invocationHint.snippet + '\n  ```' : ''}`,
    ),
    '',
    proposal.vetoes && proposal.vetoes.length > 0
      ? '## MUST NOT\n' + proposal.vetoes.map((v) => `- ${v}`).join('\n')
      : '',
    '',
    `> Generated by aab actions solve from action ${brief.action.id.slice(0, 8)}; planner tier ${brief.capabilityProfile.acceptedTier}; ${proposal.integrations.length} integrations.`,
    '',
  ].join('\n');
}
