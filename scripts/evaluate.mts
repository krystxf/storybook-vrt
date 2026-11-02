// Render the sticky PR comment AND set the `visual-regression` commit status.
//
// Visual *changes* block the PR (status = failure) until approved by commenting:
//   approve changes UI/Button            -> every variant of that component
//   approve changes UI/Button › Default  -> a single story (both themes)
// Multiple approvals = multiple lines. Added/removed stories are informational
// and never block. Only repo owners/members/collaborators can approve.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER            (required)
//      HEAD_SHA (commit the status attaches to; falls back to COMMIT_SHA)
//      GITHUB_SERVER_URL, REPORT, DRY_RUN=1
import fs from 'node:fs';
import type { Report, ReportItem } from './lib.mts';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.PR_NUMBER;
const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
const headSha = process.env.HEAD_SHA || process.env.COMMIT_SHA || '';
const MARKER = '<!-- visual-regression-bot -->';
// Reports over GitHub's comment limit continue in extra comments, each tagged with its part number.
const partMarker = (n: number): string => (n === 1 ? MARKER : `<!-- visual-regression-bot part=${n} -->`);
const PART_RE = /^<!-- visual-regression-bot part=(\d+) -->/;
const COMMENT_LIMIT = 65536 - 1000; // headroom for the part header and footer
const HEADING = '## 🖼️ Visual regression';
const STATUS_CONTEXT = 'visual-regression';
const APPROVER_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

if (!token || !repo || !pr) {
  console.error('Missing GITHUB_TOKEN / GITHUB_REPOSITORY / PR_NUMBER');
  process.exit(1);
}

interface GhComment {
  id: number;
  body: string;
  html_url: string;
  author_association: string;
  user?: { type?: string; login?: string };
}

const api = 'https://api.github.com';
const headers: Record<string, string> = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
  'user-agent': 'visual-regression-bot',
};
async function gh<T = unknown>(method: string, url: string, bodyObj?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Normalize an approval target / story key so "UI/Button › Default", "ui/button > default" all match.
const norm = (s: string): string => String(s).toLowerCase().replace(/\s*[›>]\s*/g, '›').replace(/\s+/g, ' ').trim();

async function fetchComments(): Promise<GhComment[]> {
  let page = 1;
  let all: GhComment[] = [];
  for (;;) {
    const batch = await gh<GhComment[]>('GET', `${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    all = all.concat(batch);
    if (batch.length < 100 || page >= 10) break;
    page++;
  }
  return all;
}

function parseApprovals(comments: GhComment[]): Set<string> {
  const set = new Set<string>();
  for (const c of comments) {
    if (!c.body || c.body.includes(MARKER) || PART_RE.test(c.body)) continue; // skip the bot's own comments
    if (c.user && (c.user.type === 'Bot' || /\[bot\]$/i.test(c.user.login ?? ''))) continue; // never trust bots
    if (!APPROVER_ROLES.has(c.author_association)) continue; // owners/members/collaborators only
    // Ignore lines inside ``` fences so our own copy-paste instructions can never self-approve.
    let inFence = false;
    for (const line of c.body.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = line.match(/^\s*approve\s+changes?\s+(.+?)\s*$/i);
      if (m) set.add(norm(m[1]));
    }
  }
  return set;
}

// Split the report into comment-sized parts; blocks are never cut in half.
function paginate(head: string, blocks: string[], footer: string): string[] {
  const parts: string[] = [];
  let cur = head;
  for (const b of blocks) {
    if (cur.length + b.length > COMMENT_LIMIT) {
      parts.push(cur);
      cur = '';
    }
    cur += b;
  }
  parts.push(cur + footer);
  if (parts.length === 1) return parts;
  return parts.map((p, idx) => {
    const n = idx + 1;
    const nav = n < parts.length ? `\n<sub>Continued in the next comment (part ${n + 1}/${parts.length}).</sub>\n` : '';
    return n === 1 ? p + nav : `${partMarker(n)}\n${HEADING} · part ${n}/${parts.length}\n\n${p}${nav}`;
  });
}

// Update the existing report comments in place, create missing parts, delete parts no longer needed.
async function upsert(parts: string[], comments: GhComment[]): Promise<string | undefined> {
  let firstUrl: string | undefined;
  for (let n = 1; n <= parts.length; n++) {
    const body = parts[n - 1];
    const existing = comments.find((c) => c.body?.startsWith(partMarker(n)));
    const c = existing
      ? await gh<GhComment>('PATCH', `${api}/repos/${repo}/issues/comments/${existing.id}`, { body })
      : await gh<GhComment>('POST', `${api}/repos/${repo}/issues/${pr}/comments`, { body });
    console.log(`${existing ? 'updated' : 'created'} comment ${c.id} (part ${n}/${parts.length})`);
    if (n === 1) firstUrl = c.html_url;
  }
  for (const c of comments) {
    const n = Number(c.body?.match(PART_RE)?.[1]);
    if (n > parts.length) {
      await gh('DELETE', `${api}/repos/${repo}/issues/comments/${c.id}`);
      console.log(`deleted stale comment ${c.id} (part ${n})`);
    }
  }
  return firstUrl;
}

async function setStatus(state: 'success' | 'failure', description: string, target_url?: string): Promise<void> {
  if (!headSha) {
    console.log('no HEAD_SHA; skipping commit status');
    return;
  }
  await gh('POST', `${api}/repos/${repo}/statuses/${headSha}`, {
    state,
    context: STATUS_CONTEXT,
    description: description.slice(0, 140),
    target_url,
  });
  console.log(`status=${state} · ${description}`);
}

const reportPath = process.env.REPORT || '.vrt/out/report.json';
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report;
const { totals, items } = report;
const short = headSha ? headSha.slice(0, 7) : '';
const MAX_OPEN = parseInt(process.env.MAX_OPEN || '8', 10);

const imgUrl = (f: string): string => {
  const url = report.imageUrls?.[f];
  if (!url && !process.env.DRY_RUN) throw new Error(`Missing attachment URL: ${f}`);
  return url || f;
};
const img = (f: string, w = 260): string => `<img src="${imgUrl(f)}" width="${w}" alt="">`;
const titleOf = (i: ReportItem): string => `${i.title} › ${i.name} · <i>${i.theme}</i>`;
const tableRow = (i: ReportItem): string =>
  `| Before | After | Diff |\n| :--: | :--: | :--: |\n| ${img(i.images!.before!)} | ${img(i.images!.after!)} | ${img(i.images!.diff!)} |\n\n`;

// DRY_RUN avoids the network; APPROVALS lets a local dry-run simulate approval comments.
const comments = process.env.DRY_RUN ? [] : await fetchComments();
const approved =
  process.env.DRY_RUN && process.env.APPROVALS
    ? new Set(process.env.APPROVALS.split(/[\n,]/).map(norm).filter(Boolean))
    : parseApprovals(comments);
const isApproved = (i: ReportItem): boolean =>
  approved.has(norm(i.title)) || approved.has(norm(`${i.title} › ${i.name}`));

const changed = items.filter((i) => i.status === 'changed');
const added = items.filter((i) => i.status === 'added');
const removed = items.filter((i) => i.status === 'removed');
const needs = changed.filter((i) => !isApproved(i));
const okChanged = changed.filter(isApproved);
const blocking = needs.length > 0;
const hasDiffs = changed.length + added.length + removed.length > 0;

// The head always stays in the first comment; story blocks fill it and any continuation comments.
let head = `${MARKER}\n${HEADING}\n\n`;
const blocks: string[] = [];
// Attach the section heading to its first block so a heading never ends a comment on its own.
const section = (heading: string, items: string[]): void => {
  if (items.length) blocks.push(`${heading}\n\n${items[0]}`, ...items.slice(1));
};

if (!hasDiffs) {
  head += `✅ **No visual changes** across ${totals.unchanged} stories${short ? ` · \`${short}\`` : ''}\n`;
} else {
  const parts: string[] = [];
  if (changed.length) parts.push(`🔴 **${changed.length}** changed`);
  if (added.length) parts.push(`🟢 **${added.length}** added`);
  if (removed.length) parts.push(`⚪ **${removed.length}** removed`);
  parts.push(`${totals.unchanged} unchanged`);
  head += `${parts.join(' · ')}${short ? ` · \`${short}\`` : ''}\n\n`;

  if (blocking) {
    const comps = [...new Set(needs.map((i) => i.title))].sort();
    const noun = needs.length > 1 ? 'changes need' : 'change needs';
    head += `> [!IMPORTANT]\n> ⛔ **${needs.length} visual ${noun} approval** before this PR can merge.\n\n`;
    head += `To approve, comment one line per item (\`approve changes <Component>\` covers all its variants):\n\n`;
    head += '```\n' + comps.map((c) => `approve changes ${c}`).join('\n') + '\n```\n\n';
  } else if (changed.length) {
    head += `✅ All ${changed.length} visual change${changed.length > 1 ? 's' : ''} approved.\n\n`;
  }

  section('### 🔴 Changed — needs approval', needs.map((i, idx) => {
    const suffix = i.sizeChanged ? ' — size changed' : '';
    const open = idx < MAX_OPEN ? ' open' : '';
    return `<details${open}>\n<summary><b>${titleOf(i)}</b>${suffix}</summary>\n\n` + tableRow(i)
      + `Approve this story: \`approve changes ${i.title} › ${i.name}\`\n\n</details>\n\n`;
  }));
  section('### ✅ Changed — approved', okChanged.map((i) =>
    `<details>\n<summary>✅ <b>${titleOf(i)}</b></summary>\n\n` + tableRow(i) + `</details>\n\n`));
  section(`### 🟢 Added <sub>(won't block)</sub>`, added.map((i) =>
    `<details>\n<summary><b>${titleOf(i)}</b> — new story</summary>\n\n${img(i.images!.after!, 320)}\n\n</details>\n\n`));
  section(`### ⚪ Removed <sub>(won't block)</sub>`, removed.map((i) =>
    `<details>\n<summary><b>${titleOf(i)}</b> — removed</summary>\n\n${img(i.images!.before!, 320)}\n\n</details>\n\n`));
}
const footer = `\n<sub>🤖 Visual regression bot · compares against the base branch · updates on every push. Approve with <code>approve changes &lt;Component&gt;</code>.</sub>`;
const bodies = paginate(head, blocks, footer);

let desc: string;
if (!hasDiffs) desc = 'No visual changes';
else if (blocking) desc = `${needs.length} visual change(s) need approval`;
else if (changed.length) desc = `All ${changed.length} visual change(s) approved`;
else desc = 'No changes needing approval';

if (process.env.DRY_RUN) {
  console.log(bodies.join('\n\n===== next comment =====\n\n'));
  console.log(`\n---\nstatus=${blocking ? 'failure' : 'success'} · ${desc}`);
  process.exit(0);
}

const htmlUrl = await upsert(bodies, comments);
await setStatus(blocking ? 'failure' : 'success', desc, htmlUrl || `${server}/${repo}/pull/${pr}`);
