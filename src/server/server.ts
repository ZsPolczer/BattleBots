/**
 * HTTP + Server-Sent-Events server.
 *
 * Static files (the viewer and the compiled engine) plus a live SSE stream of
 * world snapshots. SSE rather than WebSockets on purpose: the broadcast is
 * one-way, it is built into Node's http module, and it survives proxies and OBS
 * browser sources without any dependency.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Showcase } from './showcase.js';
import { listRuns, resolveRunDir } from '../runs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

export interface ServerOptions {
  port?: number;
  host?: string;
  run?: string;
  runDir?: string | null;
  /** Simulation speed multiplier for the broadcast. */
  speed?: number;
  /** How many world steps per second on the wire. */
  tickRate?: number;
  maxSeconds?: number;
  quiet?: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export interface RunningServer {
  port: number;
  close: () => void;
  showcase: Showcase;
}

export function startServer(opts: ServerOptions = {}): RunningServer {
  const port = opts.port ?? 8787;
  const host = opts.host ?? '127.0.0.1';
  const speed = opts.speed ?? 1;
  const tickRate = opts.tickRate ?? 60;
  const quiet = opts.quiet ?? false;

  const runDir = opts.runDir !== undefined ? opts.runDir : resolveRunDir(opts.run);
  const showcase = new Showcase(runDir, { maxSeconds: opts.maxSeconds });

  const clients = new Set<http.ServerResponse>();
  let lastMapVersion = -1;

  const log = (...args: unknown[]) => {
    if (!quiet) console.log(...args);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/live') {
      handleSse(req, res);
      return;
    }
    if (pathname === '/api/runs') {
      json(res, listRuns());
      return;
    }
    if (pathname === '/api/health') {
      json(res, { ok: true, runDir, clients: clients.size });
      return;
    }
    if (pathname === '/api/run/state') {
      const file = runDir ? path.join(runDir, 'state.json') : null;
      if (file && fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(file));
      } else {
        json(res, { generation: 0, history: [] });
      }
      return;
    }
    if (pathname === '/api/metrics.csv') {
      const file = runDir ? path.join(runDir, 'metrics.csv') : null;
      if (file && fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': MIME['.csv'], 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(file));
      } else {
        res.writeHead(404);
        res.end('no metrics yet');
      }
      return;
    }

    serveStatic(res, pathname);
  });

  function json(res: http.ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(data));
  }

  function serveStatic(res: http.ServerResponse, pathname: string): void {
    let rel = pathname;
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel === '/dashboard') rel = '/dashboard.html';

    let root: string;
    if (rel.startsWith('/dist/')) {
      root = path.join(PROJECT_ROOT, 'dist');
      rel = rel.slice('/dist'.length);
    } else {
      root = path.join(PROJECT_ROOT, 'web');
    }

    const full = path.normalize(path.join(root, rel));
    if (!full.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404');
        return;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  function handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    lastMapVersion = -1; // force a map push for the newcomer
    send(res, 'hello', { map: showcase.mapDataFor(), snapshot: showcase.snapshot() });
    const cleanup = () => clients.delete(res);
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    log(`[sse] client connected (${clients.size} total)`);
  }

  // --- simulation loop ---------------------------------------------------
  const intervalMs = 1000 / tickRate;
  let last = Date.now();
  let frame = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.4) dt = 0.4; // don't spiral after a laptop sleep
    const ticks = Math.max(1, Math.round(dt * tickRate * speed));
    showcase.advance(ticks);

    frame++;
    if (clients.size > 0 && frame % 2 === 0) {
      const mapVersion = showcase.currentMapVersion();
      if (mapVersion !== lastMapVersion) {
        lastMapVersion = mapVersion;
        broadcast('map', { map: showcase.mapDataFor() });
      }
      broadcast('frame', showcase.snapshot());
    } else if (clients.size === 0) {
      showcase.snapshot(); // discard accumulated events so they don't pile up
    }
  }, intervalMs);

  function send(res: http.ServerResponse, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  server.listen(port, host, () => {
    log('');
    log(`  BattleBot  ▸  http://${host}:${port}`);
    log(`  run        ▸  ${runDir ?? '(none — random genomes; start a training run)'}`);
    log(`  dashboard  ▸  http://${host}:${port}/dashboard`);
    log(`  OBS        ▸  Browser source -> http://${host}:${port}  (1200x2000 recommended)`);
    log('');
  });

  return {
    port,
    showcase,
    close: () => {
      clearInterval(timer);
      for (const res of clients) res.end();
      clients.clear();
      server.close();
    },
  };
}
