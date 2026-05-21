# Skill run telemetry — live WS stream

Verifies that the Web UI receives a steady stream of `skill_run_tool_call`
events during a real skill-creator run, and that the planner-progress-pane's
live stream renders them.

**Prereqs:**

- Same as `skill-solve-happy-path.md`.

**`data-testid` references:** `planner-progress-pane`, `solve-btn`.

## Steps

1. Open the Action Board.
2. `browser_click` `solve-btn` on a Recipe-A action.
3. Once the Planner finishes and the proposal modal appears, click Accept.
4. Re-open the planner-progress-pane (it was hidden on accept) by clicking
   `solve-btn` again on the same card — the pane shows the in-progress run.
5. `browser_wait_for` the `.planner-stream` div inside the pane to contain
   at least 5 rows with `tool:` prefixes (skill-creator's Write / Edit / Read
   tool calls).
6. As tool calls accumulate, verify the row count grows (≥1 new row
   every 30s) — confirms the WS stream is live.

## Expected observations

- The `aab-planner-event` browser event fires once per skill-creator tool use
  (intercepted from the `--output-format stream-json` stream-server-side).
- Each event maps to a `tool: <ToolName>` row in `.planner-stream`.
- Stream rows are capped at 20 (newest at the bottom; older rows roll off).
- No console errors during the streaming session.
