# storybook-vrt

A reusable GitHub Action for **Chromatic-style visual regression on Storybook** — posted as a
**single, auto-updating PR comment** with before/after/diff images, gated by comment approval.
No external services; works in **private repos** (images are committed to a branch in your own
repo and embedded via `github.com/<repo>/raw/<sha>/…` URLs, which render for repo members).

## Quickstart

Add one workflow to your repo (e.g. `.github/workflows/visual-regression.yml`):

```yaml
name: Visual regression
on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created, edited, deleted]

permissions:
  contents: write       # push diff images to the snapshot branch
  pull-requests: write  # upsert the sticky comment
  statuses: write       # set the blocking commit status

jobs:
  visual-regression:
    if: >
      github.event_name == 'pull_request' ||
      (github.event.issue.pull_request && github.event.comment.user.type != 'Bot' &&
       contains(github.event.comment.body, 'approve changes'))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0           # needed to build the base commit
      - uses: pnpm/action-setup@v4 # your toolchain (or setup-node alone for npm/yarn)
      - uses: actions/setup-node@v4
        with:
          node-version: 24         # >= 24 (or >= 22.18) for native TS type stripping
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: krystxf/storybook-vrt@v1
        with:
          build-command: pnpm build-storybook
```

That's it. On each push the action screenshots every story (light + dark) for the PR and its
base branch, diffs them, and posts/updates one comment. Visual **changes block** the PR until
approved.

## Approving / revoking

Comment on the PR (owner/member/collaborator only), one line per item:

```
approve changes UI/Button            # every variant of the component
approve changes UI/Button › Default  # a single story
```

Deleting (or editing out) an approval comment **revokes** it. Added/removed stories never block.

## Inputs

| Input | Default | Description |
|---|---|---|
| `build-command` | `npx storybook build` | Builds Storybook into `static-dir` (run for head and base). |
| `static-dir` | `storybook-static` | Build output directory. |
| `themes` | `light,dark` | Comma-separated Storybook themes (`globals=theme:<name>`). |
| `min-diff-pixels` | `20` | Ignore diffs smaller than this many pixels. |
| `pixelmatch-threshold` | `0.1` | Per-pixel color sensitivity (0–1). |
| `ignore-story-names` | `All Variants` | Comma-separated, case-insensitive story-name substrings to skip. |
| `snapshot-branch` | `vrt-snapshots` | Orphan branch the diff images live on. |
| `github-token` | `${{ github.token }}` | Token with `contents`/`pull-requests`/`statuses` write. |

## Requirements & notes

- **Node ≥ 24** (or ≥ 22.18) in the caller — the action runs TypeScript scripts via Node's
  native type stripping.
- **`fetch-depth: 0`** in `actions/checkout` so the base commit can be built.
- The `issue_comment` trigger runs from your repo's **default branch**, so this workflow must be
  on `main` before approvals take effect.
- To make the gate *hard-block* merges, add the **`visual-regression`** status as a required check
  in branch protection (needs GitHub Pro or a public repo for private repositories).
- Snapshot images accumulate on the `snapshot-branch`; delete that branch anytime to reclaim space
  (it's recreated on the next run).
