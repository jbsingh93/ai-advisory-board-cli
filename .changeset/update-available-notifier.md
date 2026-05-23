---
"ai-advisory-board": minor
---

Add an "update available" notifier. The CLI now shows a one-line notice when a newer version is published to npm (`↑ Update available 0.2.0 → 0.3.0  run: npm i -g ai-advisory-board@latest`), and `aab doctor` reports a "CLI version" check. The version is cached in `~/.aabcli/.update-check.json` and refreshed in the background at most once per 24h, so it never blocks or slows a command. Suppressed for non-interactive/`--json`/CI usage; opt out with `AAB_NO_UPDATE_NOTIFIER=1` (or `NO_UPDATE_NOTIFIER=1`).
