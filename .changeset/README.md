# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets). It controls how `ai-advisory-board` is versioned and published to npm.

## When you make a user-visible change

Run:

```bash
npx changeset
```

Walk through the prompts:
1. Pick the bump type — `patch` (bug fix), `minor` (new feature, backward-compatible), `major` (breaking change).
2. Write a one-line summary. This text lands in `CHANGELOG.md` verbatim on release.

The command creates a markdown file in this folder. **Commit it with your PR** — the release workflow reads these files to figure out the next version.

## What happens on merge to main

The `Release` GitHub Action runs `changesets/action`:

- If there are unreleased changesets, it opens (or updates) a **"chore: release"** PR that bumps `package.json`, updates `CHANGELOG.md`, and deletes the consumed changeset files.
- When that release PR is merged, the action runs `npm publish` via **npm trusted publishing (OIDC)** — no `NPM_TOKEN` secret required.

## When you don't need a changeset

- Internal refactors with no user-visible effect.
- Documentation-only changes (unless they describe a new feature).
- CI / tooling changes.
- Test additions.

If unsure, add one. A patch bump with "internal cleanup" is cheap; a missed user-visible change is annoying to ship later.
