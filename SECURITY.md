# Security Policy

## Supported Versions

Only the latest published `ai-advisory-board` release receives fixes. This project is
pre-1.0 — pin to an exact version if you need stability.

| Version | Supported |
| ------- | --------- |
| latest  | ✓         |
| older   | ✗         |

## Reporting an Issue

**Please do not open a public GitHub issue for anything security-relevant.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/jbsingh93/ai-advisory-board-cli/security/advisories/new>
2. Fill in the form with reproduction steps, affected version, and impact.
3. I'll acknowledge within 7 days and aim to ship a fix or mitigation within 30 days for confirmed issues.

If GitHub private advisories are unavailable to you, email
<dinegenboss@gmail.com> with the subject line `ai-advisory-board security`. Encrypted
mail is welcome but not required.

## Scope

In scope:

- The `aab` CLI and `ai-advisory-board` npm package itself.
- The local web UI server (`src/gui/server.ts`, default `localhost:3737`).
- The agent-file emitter (`.claude/agents/<slug>.md` generation).
- Workspace filesystem layout and lock handling.

Out of scope:

- The `claude` binary itself — report those to Anthropic at <https://support.anthropic.com>.
- Misconfiguration of a user's local environment (PATH, shell, OS permissions).
- Issues in dependencies that are already fixed upstream — please file there.

## Hardening Notes

This CLI runs entirely on your local machine. It does not send data to any
network endpoint other than the local `claude` binary you invoke. It does not
collect telemetry. It does not require an API key.

The web UI binds to `localhost` only and has no authentication — do not expose
it on a public interface.
