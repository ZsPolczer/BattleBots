/** Per-generation statistics. Written to CSV and printed to the terminal. */

export interface GenMetrics {
  generation: number;
  best: number;
  mean: number;
  median: number;
  worst: number;
  std: number;
  diversity: number;
  bestElo: number;
  meanElo: number;
  accuracy: number;
  kills: number;
  damage: number;
  ticks: number;
  wallHug: number;
  mobility: number;
  winVsScripted: number;
  winVsBest: number;
  weights: number;
  elapsedMs: number;
  gensPerHour: number;
}

export const METRIC_COLUMNS: Array<keyof GenMetrics> = [
  'generation',
  'best',
  'mean',
  'median',
  'worst',
  'std',
  'diversity',
  'bestElo',
  'meanElo',
  'accuracy',
  'kills',
  'damage',
  'ticks',
  'wallHug',
  'mobility',
  'winVsScripted',
  'winVsBest',
  'weights',
  'elapsedMs',
  'gensPerHour',
];

export function metricsRow(m: GenMetrics): Record<string, number> {
  const row: Record<string, number> = {};
  for (const c of METRIC_COLUMNS) {
    const v = m[c];
    row[c] = typeof v === 'number' ? round(v, 5) : 0;
  }
  return row;
}

const BLOCKS = '▁▂▃▄▅▆▇█';

export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((v - min) / span) * (BLOCKS.length - 1)))])
    .join('');
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

export function printGenHeader(): void {
  process.stdout.write(
    '\n' +
      pad('gen', 6) +
      lpad('best', 10) +
      lpad('median', 10) +
      lpad('div', 8) +
      lpad('elo', 7) +
      lpad('acc%', 7) +
      lpad('wall%', 7) +
      lpad('vsAI%', 8) +
      lpad('gen/h', 8) +
      '\n' +
      '-'.repeat(71) +
      '\n',
  );
}

export function printGen(m: GenMetrics): void {
  process.stdout.write(
    pad(String(m.generation), 6) +
      lpad(fmt(m.best), 10) +
      lpad(fmt(m.median), 10) +
      lpad(fmt(m.diversity), 8) +
      lpad(String(Math.round(m.bestElo)), 7) +
      lpad(fmt(m.accuracy * 100), 7) +
      lpad(fmt(m.wallHug * 100), 7) +
      lpad(fmt(m.winVsScripted * 100), 8) +
      lpad(fmt(m.gensPerHour), 8) +
      '\n',
  );
}

export function printSummary(history: GenMetrics[]): void {
  if (history.length === 0) return;
  const picks: Array<[string, (m: GenMetrics) => number]> = [
    ['best fitness', (m) => m.best],
    ['vs scripted', (m) => m.winVsScripted],
    ['accuracy', (m) => m.accuracy],
    ['avg elo', (m) => m.meanElo],
    ['diversity', (m) => m.diversity],
    ['wall-hugging', (m) => m.wallHug],
  ];
  process.stdout.write('\n=== training summary ===\n');
  for (const [label, fn] of picks) {
    const series = history.map(fn);
    process.stdout.write(`${pad(label, 16)} ${sparkline(series)}  ${fmt(series[0])} -> ${fmt(series[series.length - 1])}\n`);
  }
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function round(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
