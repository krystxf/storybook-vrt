import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

export interface Story {
  id: string;
  title: string;
  name: string;
}

export interface ManifestEntry extends Story {
  theme: string;
  file: string | null;
  error?: string;
}

export interface DiffImages {
  before?: string;
  after?: string;
  diff?: string;
}

export type DiffStatus = 'changed' | 'added' | 'removed' | 'unchanged';

export interface ReportItem extends Story {
  theme: string;
  key: string;
  status: DiffStatus;
  diffPixels?: number;
  ratio?: number;
  sizeChanged?: boolean;
  images?: DiffImages;
}

export interface Report {
  totals: Record<DiffStatus, number>;
  items: ReportItem[];
  minPixels: number;
  threshold: number;
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

interface StorybookIndexEntry {
  type: string;
  id: string;
  title: string;
  name: string;
}

// Story names to skip (case-insensitive substring match). Composite stories like
// "All Variants" duplicate coverage already in the individual variant stories.
const IGNORE_STORY_NAMES = (process.env.VRT_IGNORE_STORY_NAMES ?? 'All Variants')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Read Storybook's built index.json and return the playable (non-docs) stories. */
export function listStories(staticDir: string): Story[] {
  const idx = readJson<{ entries: Record<string, StorybookIndexEntry> }>(
    path.join(staticDir, 'index.json'),
  );
  return Object.values(idx.entries)
    .filter((e) => e.type === 'story')
    .filter((e) => !IGNORE_STORY_NAMES.some((p) => e.name.toLowerCase().includes(p)))
    .map((e) => ({ id: e.id, title: e.title, name: e.name }));
}

export function readPng(file: string): PNG {
  return PNG.sync.read(fs.readFileSync(file));
}

export function writePng(png: PNG, file: string): void {
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Copy `src` into a fresh w×h canvas (top-left aligned), filling the rest with `fill` rgba. */
export function pad(
  src: PNG,
  w: number,
  h: number,
  fill: [number, number, number, number] = [255, 255, 255, 0],
): PNG {
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = fill[0];
    out.data[i + 1] = fill[1];
    out.data[i + 2] = fill[2];
    out.data[i + 3] = fill[3];
  }
  const rows = Math.min(src.height, h);
  const cols = Math.min(src.width, w);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const si = (src.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** Filesystem/URL-safe slug. */
export function safe(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '-');
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        a[key] = next;
        i++;
      } else {
        a[key] = true;
      }
    }
  }
  return a;
}
