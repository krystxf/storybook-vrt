// Compare two capture dirs (base vs head) and emit before/after/diff images + report.json.
//
//   node diff.mts --base <dir> --head <dir> --out <dir>
//
// Env: MIN_DIFF_PIXELS (default 20), PIXELMATCH_THRESHOLD (default 0.1)
import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  readJson, ensureDir, readPng, writePng, pad, safe, parseArgs,
  type ManifestEntry, type ReportItem, type Report, type DiffStatus,
} from './lib.mts';

const args = parseArgs(process.argv.slice(2));
const baseDir = args.base as string | undefined;
const headDir = args.head as string | undefined;
const outDir = args.out as string | undefined;
const minPixels = parseInt(process.env.MIN_DIFF_PIXELS ?? '20', 10);
const threshold = parseFloat(process.env.PIXELMATCH_THRESHOLD ?? '0.1');

if (!baseDir || !headDir || !outDir) {
  console.error('Usage: diff.mts --base <dir> --head <dir> --out <dir>');
  process.exit(1);
}
ensureDir(outDir);

const baseM = readJson<ManifestEntry[]>(path.join(baseDir, 'manifest.json')).filter((m) => m.file);
const headM = readJson<ManifestEntry[]>(path.join(headDir, 'manifest.json')).filter((m) => m.file);
const key = (m: ManifestEntry): string => `${m.id}__${m.theme}`;
const baseMap = new Map(baseM.map((m) => [key(m), m]));
const headMap = new Map(headM.map((m) => [key(m), m]));
const keys = [...new Set([...baseMap.keys(), ...headMap.keys()])].sort();

const items: ReportItem[] = [];
for (const k of keys) {
  const b = baseMap.get(k);
  const h = headMap.get(k);
  const meta = (h ?? b)!;
  const stub = { id: meta.id, title: meta.title, name: meta.name, theme: meta.theme, key: safe(k) };

  if (b && !h) {
    const before = `${safe(k)}.before.png`;
    fs.copyFileSync(path.join(baseDir, b.file!), path.join(outDir, before));
    items.push({ ...stub, status: 'removed', images: { before } });
    continue;
  }
  if (!b && h) {
    const after = `${safe(k)}.after.png`;
    fs.copyFileSync(path.join(headDir, h.file!), path.join(outDir, after));
    items.push({ ...stub, status: 'added', images: { after } });
    continue;
  }

  const bp = readPng(path.join(baseDir, b!.file!));
  const hp = readPng(path.join(headDir, h!.file!));
  const w = Math.max(bp.width, hp.width);
  const ht = Math.max(bp.height, hp.height);
  const bb = bp.width === w && bp.height === ht ? bp : pad(bp, w, ht);
  const hh = hp.width === w && hp.height === ht ? hp : pad(hp, w, ht);
  const diff = new PNG({ width: w, height: ht });
  const diffPixels = pixelmatch(bb.data, hh.data, diff.data, w, ht, {
    threshold,
    includeAA: false,
    alpha: 0.4,
  });
  const ratio = diffPixels / (w * ht);
  const sizeChanged = bp.width !== hp.width || bp.height !== hp.height;

  if (diffPixels >= minPixels || sizeChanged) {
    const before = `${safe(k)}.before.png`;
    const after = `${safe(k)}.after.png`;
    const dfile = `${safe(k)}.diff.png`;
    fs.copyFileSync(path.join(baseDir, b!.file!), path.join(outDir, before));
    fs.copyFileSync(path.join(headDir, h!.file!), path.join(outDir, after));
    writePng(diff, path.join(outDir, dfile));
    items.push({ ...stub, status: 'changed', diffPixels, ratio, sizeChanged, images: { before, after, diff: dfile } });
  } else {
    items.push({ ...stub, status: 'unchanged', diffPixels, ratio });
  }
}

const totals: Record<DiffStatus, number> = { changed: 0, added: 0, removed: 0, unchanged: 0 };
for (const it of items) totals[it.status]++;
const report: Report = { totals, items, minPixels, threshold };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log('diff totals:', JSON.stringify(totals));
