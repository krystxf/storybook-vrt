// Show progress in the `visual-regression` commit status while the job runs.
// evaluate.mts replaces it with the final success/failure status.
//
// CLI:  node status.mts <pending|error> "<description>"
// Env:  STATUS_TOKEN, GITHUB_REPOSITORY, HEAD_SHA   (silently skipped when missing)
//       GITHUB_SERVER_URL, GITHUB_RUN_ID            (link the status to the running job)
// No dependencies, so it can run before the action's npm install.
import { pathToFileURL } from 'node:url';

export async function setProgress(state: 'pending' | 'error', description: string): Promise<void> {
  const token = process.env.STATUS_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.HEAD_SHA;
  if (!token || !repo || !sha) return;
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const runId = process.env.GITHUB_RUN_ID;
  // Progress is cosmetic: never fail the job because the status could not be set.
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'visual-regression-bot',
      },
      body: JSON.stringify({
        state,
        context: 'visual-regression',
        description: description.slice(0, 140),
        target_url: runId ? `${server}/${repo}/actions/runs/${runId}` : undefined,
      }),
    });
    if (!res.ok) console.warn(`Cannot set progress status: ${res.status} ${await res.text()}`);
    else console.log(`status=${state} · ${description}`);
  } catch (err) {
    console.warn(`Cannot set progress status: ${(err as Error).message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [state, description] = process.argv.slice(2);
  if (state !== 'pending' && state !== 'error') throw new Error('Usage: status.mts <pending|error> "<description>"');
  await setProgress(state, description ?? '');
}
