---
"ai-advisory-board": minor
---

Boards (member groups) + dynamic member targeting in discussions (Phase 7).

- **Boards:** group members into named, reusable panels. New `aab board {list,show,create,edit,add-member,remove-member,set-members,rename,delete,use,current}` command; convene a board with `aab discuss start "<q>" --board <slug>` (echoes "Convening: …" and enforces `maxMembersPerDiscussion` — blocks an over-cap board). `aab init` seeds a "Full Board" and sets it active. The active board is per-workspace (`settings.activeBoardId`, kubectx-style `use`/`use -`/`current`). Deleting a member now cascade-prunes them from every board (emptied boards are kept and flagged, never auto-deleted). Resolution precedence: `--members` > `--board` > `AAB_BOARD` env > active board > all active members.
- **Web boards:** a Boards section in the Board-members view (cards with overlapped avatars, member count, active badge, Set-active/Edit/Delete) + create/edit modal, and a board picker on the new-discussion screen that pre-fills members. Full `/api/boards` REST + `board_*` WebSocket events.
- **Dynamic member add:** bring a member who was never in a discussion into a live follow-up — `aab discuss follow-up <id> "<q>" --add-member <name> --catch-up full|summary|fresh` (CLI) or the "+ Add member" affordance in the web follow-up composer. New members choose how they catch up: the full transcript (default), a summary of prior rounds, or a fresh take. Added members join the roster (future rounds include them); whether they answer this round follows the existing `all`/targeted/subset targeting.
- **Participant snapshot:** discussions now record an append-only `participants` roster (name/slug/title at join time) so transcripts render correctly even after a member is renamed or deleted. Legacy discussions are back-filled on the next save. Join events render a "＋N joined" badge on the round divider.
