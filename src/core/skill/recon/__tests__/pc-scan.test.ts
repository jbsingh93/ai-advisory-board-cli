import { describe, expect, it } from 'vitest';
import { ENV_VAR_ALLOW_PATTERNS, quickPcScanProbe, scan } from '../pc-scan.js';

describe('ENV_VAR_ALLOW_PATTERNS', () => {
  it('matches well-known integration env vars', () => {
    const positives = [
      'STRIPE_KEY', 'STRIPE_RESTRICTED_KEY', 'HUBSPOT_TOKEN', 'SLACK_BOT_TOKEN',
      'GOOGLE_APPLICATION_CREDENTIALS', 'NOTION_TOKEN', 'LINEAR_API_KEY',
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID',
      'GCP_PROJECT', 'AZURE_TENANT_ID', 'DATABASE_URL', 'GITHUB_TOKEN',
      'FIGMA_TOKEN', 'CANVA_API_KEY', 'ELGATO_PROMPTER_PORT',
      'GREENHOUSE_API_KEY', 'CARTA_API_KEY', 'YOUTUBE_API_KEY',
    ];
    for (const key of positives) {
      expect(ENV_VAR_ALLOW_PATTERNS.some((re) => re.test(key)), `should match ${key}`).toBe(true);
    }
  });

  it('rejects unrelated env vars', () => {
    const negatives = ['PATH', 'HOME', 'USER', 'TERM', 'SHELL', 'LANG', 'PWD', 'NODE_VERSION'];
    for (const key of negatives) {
      expect(ENV_VAR_ALLOW_PATTERNS.some((re) => re.test(key)), `should not match ${key}`).toBe(false);
    }
  });
});

describe('quickPcScanProbe', () => {
  it('returns ok=true on the current platform', () => {
    const r = quickPcScanProbe();
    expect(r.ok).toBe(true);
    expect(['win32', 'darwin', 'linux']).toContain(r.platform);
    expect(typeof r.cliTools).toBe('number');
    expect(typeof r.envVarMatches).toBe('number');
    expect(typeof r.mcpServers).toBe('number');
    expect(typeof r.skills).toBe('number');
  });
});

describe('scan (smoke)', () => {
  // NOTE: these tests pass `PATH: ''` deliberately. A real PATH makes `scan`
  // shell out `--version` to every CLI tool it finds (~80 synchronous
  // execFileSync calls, ~15s on CI) — that blocked the vitest worker long
  // enough to trip its `onTaskUpdate` RPC heartbeat. Keep them hermetic.
  it('produces a structurally-valid ReconResult', () => {
    const r = scan({ envOverride: { STRIPE_KEY: 'sk_redacted', NOTION_TOKEN: 't', PATH: '' } });
    expect(['win32', 'darwin', 'linux']).toContain(r.platform);
    expect(Array.isArray(r.apps)).toBe(true);
    expect(Array.isArray(r.cliTools)).toBe(true);
    expect(Array.isArray(r.mcpServers)).toBe(true);
    expect(Array.isArray(r.envVars)).toBe(true);
    expect(Array.isArray(r.existingSkills)).toBe(true);
    expect(typeof r.scannedAt).toBe('string');
    // Env-var values must never leak — we expose names only.
    expect(r.envVars).toContain('STRIPE_KEY');
    expect(r.envVars).toContain('NOTION_TOKEN');
    expect(JSON.stringify(r.envVars)).not.toContain('sk_redacted');
  });

  it('respects the projectRoot override for MCP detection', () => {
    const r = scan({ projectRoot: '/non-existent-dir', envOverride: { PATH: '' } });
    expect(r.mcpServers).toEqual(expect.any(Array));
  });

  it('caps apps at 200 and cli tools at 80', () => {
    const r = scan({ envOverride: { PATH: '' } });
    expect(r.apps.length).toBeLessThanOrEqual(200);
    expect(r.cliTools.length).toBeLessThanOrEqual(80);
  });

  it('caps mcp servers and skills, and tags valid sources/scopes', () => {
    const r = scan({ envOverride: { PATH: '' } });
    expect(r.mcpServers.length).toBeLessThanOrEqual(500);
    expect(r.existingSkills.length).toBeLessThanOrEqual(500);
    const validSources = ['project', 'user', 'global', 'claude.ai', 'claude-desktop', 'cursor', 'windsurf', 'vscode', 'disk'];
    for (const s of r.mcpServers) expect(validSources).toContain(s.source);
    for (const s of r.existingSkills) expect(['project', 'user', 'plugin', 'disk']).toContain(s.scope);
  });

  it('deepScan terminates within its disk budget and stays structurally valid', () => {
    const r = scan({ envOverride: { PATH: '' }, deepScan: true, diskBudgetMs: 1500, diskRoots: [] });
    expect(Array.isArray(r.mcpServers)).toBe(true);
    expect(Array.isArray(r.existingSkills)).toBe(true);
  });
});
