# `docs/specs/knowledge-tab.md` — Knowledge Wiki: pages, [[slug]] resolution, ingest / query / lint

**Phase:** 1.5 (Knowledge Wiki) + 6.6 (test infrastructure)
**Surface:** `data-testid="tab-knowledge"` sidebar → knowledge view.

**Endpoints:**
- `GET /api/knowledge` — list wiki pages + manifest snapshot.
- `GET /api/knowledge/:slug` — page detail with body.
- `POST /api/knowledge/ingest` — ingest a new source under `raw/`, optionally summarise into `wiki/`.
- `POST /api/knowledge/query` — semantic search over wiki pages.
- `POST /api/knowledge/lint` — lint the wiki for broken `[[slug]]` links + stale manifest entries.
- WS events: `wiki_ingested`, `wiki_updated`, `wiki_deleted`, `wiki_linted` — each invalidates the in-memory slug map.

**Engine:** `src/core/knowledge/*` (see `project-phase-1-5-shipped` memory note).

## Pre-conditions
- Workspace bootstrapped via `aab init` (creates `wiki/`, `raw/`, `.manifest.json`).
- ≥1 ingested page (or the test ingests one as step 1).

**`data-testid` references:** `tab-knowledge`, plus the knowledge view's own
`knowledge-list`, `knowledge-page-<slug>`, `knowledge-ingest-btn`,
`knowledge-query-input`, `knowledge-query-btn`, `knowledge-lint-btn`
(verify exact testids by `browser_snapshot` of the rendered view).

## Steps
1. `browser_click tab-knowledge`.
2. `browser_snapshot`. Verify the page-list panel renders one row per `wiki/<slug>.md`.
3. **View a page:** `browser_click` a row. The detail pane shows the page body with `[[other-slug]]` rewritten into clickable internal links (handled by `gui/wikilinks.js`).
4. **Cross-link navigation:** click a `[[slug]]` link in the body. The detail pane swaps to the target page without a full-page reload.
5. **Ingest a new source:**
   - `browser_click knowledge-ingest-btn`. Modal opens.
   - Provide a URL or paste raw text.
   - Submit. Toast `Ingested — wiki updated.` arrives via WS.
   - `browser_wait_for { text: "<new page title>" }` in the page list.
6. **Query:**
   - `browser_type knowledge-query-input`: a question that hits the freshly ingested page.
   - `browser_click knowledge-query-btn`.
   - Verify the result panel shows ≥1 hit citing the new page's `<slug>`.
7. **Lint:**
   - Manually rename a wiki page via `aab knowledge rename <old> <new>` from a terminal, OR delete one via `aab knowledge delete`.
   - Switch back to the browser. `browser_click knowledge-lint-btn`.
   - Verify the lint panel reports the broken `[[old-slug]]` references with the suggested fix.

## Expected observations
- Page list is sorted by `manifest.updatedAt desc`.
- Wikilink rewriting happens client-side via `rewriteWikiLinks()` in `gui/wikilinks.js`; the source `<a>` carries `data-slug`.
- `wiki_*` WS events trigger `refreshKnowledgeState()` so the in-memory slug map invalidates without a page reload.

## Failure modes worth a screenshot
- A `[[slug]]` link renders as plain text (slug map not invalidated after ingest).
- Lint reports a stale page even after `aab knowledge lint` succeeded on the CLI (server cache mismatch).
- Query returns no hits for an obviously-matching page (embedding/indexing regression).
