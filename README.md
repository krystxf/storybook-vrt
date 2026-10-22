# storybook-vrt

A reusable GitHub Action for **Chromatic-style visual regression on Storybook** — posted as a
**single, auto-updating PR comment** with before/after/diff images, gated by comment approval.
No external services; works in **private repos**.

## Quickstart

Create a repository Actions secret named `VRT_ATTACHMENT_TOKEN` containing a user PAT or OAuth
token with push access to the repository. The built-in Actions `GITHUB_TOKEN` cannot upload
attachments. Keep this token scoped to repositories that need screenshot publishing.

Add one workflow to your repo (e.g. `.github/workflows/visual-regression.yml`):

```yaml
name: Visual regression
on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created, edited, deleted]

permissions:
  contents: read       # check out and build both commits
  actions: read        # retrieve reports for approval checks
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
      - uses: krystxf/storybook-vrt@v2
        with:
          attachment-token: ${{ secrets.VRT_ATTACHMENT_TOKEN }}
          build-command: pnpm build-storybook
          ignore-story-names: "All Variants" # optional; comma-separated, case-insensitive
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
| `attachment-token` | required | User PAT or OAuth token with repository push access for image uploads. |
| `github-token` | `${{ github.token }}` | Token with `pull-requests`/`statuses` write, `actions` read. |

## Requirements & notes

- **Node ≥ 24** (or ≥ 22.18) in the caller — the action runs TypeScript scripts via Node's
  native type stripping.
- **`fetch-depth: 0`** in `actions/checkout` so the base commit can be built.
- The `issue_comment` trigger runs from your repo's **default branch**, so this workflow must be
  on `main` before approvals take effect.
- To make the gate *hard-block* merges, add the **`visual-regression`** status as a required check
  in branch protection (needs GitHub Pro or a public repo for private repositories).
- Create a `VRT_ATTACHMENT_TOKEN` repository secret containing a user PAT with repository push access.
  GitHub App installation tokens, including Actions `GITHUB_TOKEN`, cannot upload attachments.
  The separate `github-token` input still defaults to the normal workflow token for comments and statuses.
- GitHub CLI ≥ 2.99 with `gh pr comment --attach` support is required. The publisher batches uploads
  at 50 images per command and rejects images over 10 MiB.
- Temporary upload comments are deleted only after the sticky report embeds their hosted image URLs.
- Approval checks read an Actions report artifact for the exact PR head SHA. Reports follow the
  repository's artifact retention policy; after expiry, rerun visual regression before approving.
- Fork PR workflows normally lack the secrets and write permissions required to publish reports.

## Migrating from v1

- Use `krystxf/storybook-vrt@v2` and pass `attachment-token: ${{ secrets.VRT_ATTACHMENT_TOKEN }}`.
- Remove the `snapshot-branch` input. Change `contents: write` to `contents: read` and add `actions: read`.
- Merge the updated workflow into the default branch so approval comments use artifact reports.
- Rerun open PR checks to create reports and attachment URLs, then delete the old `vrt-snapshots`
  branch (or your configured snapshot branch). Old comments pointing to those snapshots may lose images.
- Artifacts are retained according to repository settings. Rerun checks if the report has expired.

## Demo

See the [demo PR](https://github.com/krystxf/storybook-vrt-example/pull/21)
for before/after/diff comparisons and comment-based approvals.
