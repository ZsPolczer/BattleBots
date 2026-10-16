/**
 * Persistence.
 *
 * Everything that lets you resume, replay, and keep the show running unattended:
 *  - full population checkpoints on a rolling window (disk stays bounded),
 *  - the champion written every single generation (so a crash costs minutes),
 *  - a flat metrics file you can plot without parsing a thousand JSONs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Genome } from '../brain/brain.js';
import { fromGenome, toGenome, type Individual } from './individual.js';

export interface RunManifest {
  runId: string;
  createdAt: string;
  config: unknown;
  schema: 1;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJsonGz(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(data), 'utf8')));
}

export function readJsonGz<T>(file: string): T | null {
  try {
    return JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function populationFile(dir: string, generation: number): string {
  return path.join(dir, 'gen', `gen_${String(generation).padStart(6, '0')}.json.gz`);
}

export function savePopulation(dir: string, generation: number, pop: Individual[]): string {
  const file = populationFile(dir, generation);
  writeJsonGz(file, {
    generation,
    genomes: pop.map((p) => toGenome(p)),
  });
  return file;
}

export function loadPopulation(
  dir: string,
  generation: number,
): { generation: number; genomes: Genome[] } | null {
  return readJsonGz(
    path.join(dir, 'gen', `gen_${String(generation).padStart(6, '0')}.json.gz`),
  );
}

/** Newest checkpoint that exists, or null. */
export function latestPopulationFile(dir: string): string | null {
  const genDir = path.join(dir, 'gen');
  if (!fs.existsSync(genDir)) return null;
  const files = fs
    .readdirSync(genDir)
    .filter((f) => f.startsWith('gen_') && f.endsWith('.json.gz'))
    .sort();
  if (files.length === 0) return null;
  return path.join(genDir, files[files.length - 1]);
}

export function prunePopulationDir(dir: string, keep: number): void {
  const genDir = path.join(dir, 'gen');
  if (!fs.existsSync(genDir)) return;
  const files = fs
    .readdirSync(genDir)
    .filter((f) => f.startsWith('gen_') && f.endsWith('.json.gz'))
    .sort();
  while (files.length > keep) {
    const f = files.shift()!;
    try {
      fs.unlinkSync(path.join(genDir, f));
    } catch {
      /* ignore */
    }
  }
}

export function saveChampion(dir: string, ind: Individual, generation: number): void {
  writeJson(path.join(dir, 'best.json'), {
    generation,
    genome: toGenome(ind),
    meta: {
      name: ind.name,
      elo: Math.round(ind.elo),
      fitness: round(ind.fitness, 3),
      wins: ind.wins,
      losses: ind.losses,
      draws: ind.draws,
      avgAccuracy: round(ind.avgAccuracy, 4),
      avgDamage: round(ind.avgDamage, 2),
      avgWallHug: round(ind.avgWallHug, 4),
    },
  });
}

export interface ChampionFile {
  generation: number;
  genome: Genome;
  meta: Record<string, number | string>;
}

export function loadChampion(dir: string): ChampionFile | null {
  return readJson<ChampionFile>(path.join(dir, 'best.json'));
}

export function saveHallOfFame(dir: string, hof: Individual[]): void {
  writeJson(path.join(dir, 'halloffame.json'), {
    genomes: hof.map((h) => toGenome(h)),
  });
}

export function loadHallOfFame(dir: string): Individual[] {
  const data = readJson<{ genomes: Genome[] }>(path.join(dir, 'halloffame.json'));
  if (!data) return [];
  return data.genomes.map((g) => fromGenome(g));
}

/** Append a flat JSON object as one CSV line. Creates the header on first write. */
export class CsvWriter {
  private headerWritten = false;
  private columns: string[] = [];

  constructor(private readonly file: string) {
    ensureDir(path.dirname(file));
    if (fs.existsSync(file)) {
      const first = fs.readFileSync(file, 'utf8').split('\n')[0];
      if (first) {
        this.columns = first.split(',');
        this.headerWritten = true;
      }
    }
  }

  append(row: Record<string, number | string>): void {
    ensureDir(path.dirname(this.file));
    if (!this.headerWritten) {
      this.columns = Object.keys(row);
      fs.appendFileSync(this.file, this.columns.join(',') + '\n', 'utf8');
      this.headerWritten = true;
    }
    const line = this.columns
      .map((c) => {
        const v = row[c];
        return v === undefined ? '' : String(v);
      })
      .join(',');
    fs.appendFileSync(this.file, line + '\n', 'utf8');
  }
}

function round(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
