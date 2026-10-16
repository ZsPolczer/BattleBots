/** Discovery helpers for `runs/` directories, shared by the CLI and the server. */

import fs from 'node:fs';
import path from 'node:path';

export interface RunInfo {
  id: string;
  dir: string;
  mtime: number;
  generation: number;
  hasChampion: boolean;
  population: number;
  championName: string;
  bestElo: number;
}

export function runsRoot(cwd = process.cwd()): string {
  return path.join(cwd, 'runs');
}

export function newRunId(seed: number): string {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
  const time = [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${stamp}_${time}_seed${seed}`;
}

export function listRuns(root = runsRoot()): RunInfo[] {
  if (!fs.existsSync(root)) return [];
  const out: RunInfo[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const configFile = path.join(dir, 'config.json');
    if (!fs.existsSync(configFile)) continue;
    let generation = 0;
    let population = 0;
    let championName = '';
    let bestElo = 0;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      generation = state.generation ?? 0;
      population = state.population ?? 0;
      championName = state.champion ?? '';
      bestElo = state.bestElo ?? 0;
    } catch {
      /* no state yet */
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch {
      /* ignore */
    }
    out.push({
      id: entry.name,
      dir,
      mtime,
      generation,
      hasChampion: fs.existsSync(path.join(dir, 'best.json')),
      population,
      championName,
      bestElo,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function latestRun(root = runsRoot()): RunInfo | null {
  return listRuns(root)[0] ?? null;
}

export function resolveRunDir(input: string | undefined, root = runsRoot()): string | null {
  if (input) {
    const p = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
    return fs.existsSync(p) ? p : null;
  }
  return latestRun(root)?.dir ?? null;
}
