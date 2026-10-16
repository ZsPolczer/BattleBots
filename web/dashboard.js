/**
 * Training dashboard.
 *
 * Polls /api/run/state (which the trainer rewrites every generation) and draws
 * plain canvas charts. No chart library: the whole point is that this runs with
 * zero install and can be screen-captured as a picture-in-picture on stream.
 */

const PALETTE = {
  best: '#3ddc97',
  median: '#4dd2ff',
  worst: '#7f8da8',
  bestElo: '#ffd166',
  meanElo: '#ff8fa3',
  accuracy: '#8aff80',
  wallHug: '#ff4d6d',
  scripted: '#c77dff',
  diversity: '#00e5b0',
};

const charts = [
  {
    id: 'c-fit',
    series: [
      { key: 'best', color: PALETTE.best },
      { key: 'median', color: PALETTE.median },
      { key: 'worst', color: PALETTE.worst },
    ],
  },
  {
    id: 'c-elo',
    series: [
      { key: 'bestElo', color: PALETTE.bestElo },
      { key: 'meanElo', color: PALETTE.meanElo },
    ],
  },
  {
    id: 'c-skill',
    series: [
      { key: 'accuracy', color: PALETTE.accuracy, percent: true },
      { key: 'wallHug', color: PALETTE.wallHug, percent: true },
    ],
  },
  {
    id: 'c-gen',
    series: [
      { key: 'winVsScripted', color: PALETTE.scripted, percent: true },
      { key: 'diversity', color: PALETTE.diversity },
    ],
  },
];

function drawChart(canvas, history, series) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 46;
  const padR = 10;
  const padT = 8;
  const padB = 20;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  if (!history || history.length === 0) return;

  // work out the value range across all series
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const row of history) {
      const v = row[s.key];
      if (!Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (max - min < 1e-6) {
    max += 1;
    min -= 1;
  }
  const span = max - min;
  min -= span * 0.06;
  max += span * 0.06;

  const xAt = (i) => padL + (history.length === 1 ? plotW / 2 : (i / (history.length - 1)) * plotW);
  const yAt = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

  // grid + axis labels
  ctx.strokeStyle = 'rgba(120,150,200,0.12)';
  ctx.fillStyle = '#7f8da8';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    const y = Math.round(yAt(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(Math.abs(v) < 10 ? 2 : 0), padL - 6, y + 3.5);
  }

  // generation labels
  ctx.textAlign = 'center';
  const first = history[0].generation;
  const last = history[history.length - 1].generation;
  ctx.fillText(String(first), padL + 8, h - 5);
  if (last !== first) ctx.fillText(String(last), w - padR - 8, h - 5);

  // series
  for (const s of series) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < history.length; i++) {
      const v = history[i][s.key];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = xAt(i);
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // dot on the last point
    for (let i = history.length - 1; i >= 0; i--) {
      const v = history[i][s.key];
      if (!Number.isFinite(v)) continue;
      ctx.beginPath();
      ctx.arc(xAt(i), yAt(v), 3, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      break;
    }
  }
}

function fmt(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function renderStats(state) {
  const history = state.history || [];
  const last = history[history.length - 1];
  const stats = document.getElementById('stats');
  if (!last) {
    stats.innerHTML = '';
    return;
  }
  const items = [
    ['generation', String(last.generation)],
    ['best elo', String(Math.round(last.bestElo))],
    ['vs scripted', `${fmt((last.winVsScripted ?? 0) * 100, 0)}%`],
    ['accuracy', `${fmt(last.accuracy * 100, 1)}%`],
    ['wall-hug', `${fmt(last.wallHug * 100, 1)}%`],
    ['diversity', fmt(last.diversity)],
    ['gen/hour', fmt(last.gensPerHour, 0)],
  ];
  stats.innerHTML = items
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`)
    .join('');
}

async function tick() {
  try {
    const res = await fetch('/api/run/state', { cache: 'no-store' });
    const state = await res.json();
    const history = (state.history || []).filter((r) => Number.isFinite(r.best));
    document.getElementById('rundir').textContent = state.champion
      ? `champion ${state.champion} · generation ${state.generation}`
      : 'no run';
    if (history.length === 0) {
      document.getElementById('empty').style.display = 'block';
      document.getElementById('grid').style.display = 'none';
      return;
    }
    document.getElementById('empty').style.display = 'none';
    document.getElementById('grid').style.display = 'grid';
    renderStats(state);
    for (const c of charts) {
      const canvas = document.getElementById(c.id);
      if (canvas) drawChart(canvas, history, c.series);
    }
  } catch {
    document.getElementById('rundir').textContent = 'waiting for the server…';
  }
}

tick();
setInterval(tick, 2000);
window.addEventListener('resize', () => tick());
