// Upload screenshots in batches, retain their hosted URLs in the report, then
// remove temporary upload comments after the sticky report references the assets. Attachments live independently of Git.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Report } from './lib.mts';

const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.PR_NUMBER;
if (!repo || !pr) throw new Error('Missing GITHUB_REPOSITORY / PR_NUMBER');
const reportPath = process.env.REPORT || '.vrt/out/report.json';
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report;
const files = [...new Set(report.items.flatMap(i => Object.values(i.images || {})))];
const cli = (args: string[]) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
if (!cli(['pr', 'comment', '--help']).includes('--attach')) {
  throw new Error('GitHub CLI with gh pr comment --attach support is required; upgrade gh.');
}
const commentsPath = path.join(path.dirname(reportPath), 'upload-comments.json');
if (process.argv.includes('--cleanup')) {
  const ids: string[] = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
  for (const id of ids) cli(['api', '--method', 'DELETE', `repos/${repo}/issues/comments/${id}`]);
  process.exit(0);
}
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!token || /^(ghs_|ghr_)/.test(token)) {
  throw new Error('Set attachment-token to a user PAT or OAuth token with repository push access; Actions GITHUB_TOKEN cannot upload attachments.');
}
const commentIds: string[] = [];
fs.writeFileSync(commentsPath, '[]');
report.imageUrls = {};
for (let start = 0; start < files.length; start += 50) {
  const batch = files.slice(start, start + 50);
  const localFiles = batch.map(file => path.resolve(path.dirname(reportPath), file));
  for (const file of localFiles) {
    if (fs.statSync(file).size > 10 * 1024 * 1024) throw new Error(`Image exceeds GitHub attachment limit: ${file}`);
  }
  const bodyFile = path.join(path.dirname(reportPath), 'attachments.md');
  fs.writeFileSync(bodyFile, 'Uploading visual regression images…\n\n' + localFiles.map((file, i) => `![vrt-${i}](${file})`).join('\n'));
  const url = cli(['pr', 'comment', pr, '--repo', repo, '--body-file', bodyFile,
    ...localFiles.flatMap(file => ['--attach', file])]).trim();
  const id = url.match(/#issuecomment-(\d+)$/)?.[1];
  if (!id) throw new Error(`Cannot identify upload comment: ${url}`);
  commentIds.push(id);
  fs.writeFileSync(commentsPath, JSON.stringify(commentIds));
  const endpoint = `repos/${repo}/issues/comments/${id}`;
  const comment = JSON.parse(cli(['api', endpoint])) as { body: string };
  for (let i = 0; i < batch.length; i++) {
    const uploaded = comment.body.match(new RegExp(`!\\[vrt-${i}\\]\\((https://[^\\s)]+)\\)`))?.[1];
    if (!uploaded) throw new Error(`Missing attachment URL for ${batch[i]}`);
    report.imageUrls[batch[i]] = uploaded;
  }
  // Keep uploads referenced until the sticky report has been published.
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
