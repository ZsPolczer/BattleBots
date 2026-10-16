/**
 * BattleBot broadcast viewer.
 *
 * Renders the snapshot stream from `/api/live`. Everything here is cosmetic:
 * the simulation is authoritative and already happened server-side. That means
 * this file is free to use Math.random, wall-clock time, and easing — none of
 * which are allowed anywhere in the engine.
 *
 * Watchability rules encoded below:
 *  - an auto-director picks the camera framing, because nobody is driving,
 *  - hits produce tracers, bursts, damage numbers and screen shake,
 *  - every round ends with a readable banner and a beat of intermission,
 *  - the safe zone is drawn, because "why are they running left" needs an answer.
 */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

const el = {
  gen: document.getElementById('gen'),
  round: document.getElementById('round'),
  defenses: document.getElementById('defenses'),
  score: document.getElementById('score'),
  killfeed: document.getElementById('killfeed'),
  banner: document.getElementById('banner'),
  status: document.getElementById('status'),
  tps: document.getElementById('tps'),
  fps: document.getElementById('fps'),
  zoneR: document.getElementById('zoneR'),
  championName: document.getElementById('championName'),
  championElo: document.getElementById('championElo'),
  championHp: document.getElementById('championHp'),
  championGen: document.getElementById('championGen'),
  championCard: document.getElementById('championCard'),
  challengerName: document.getElementById('challengerName'),
  challengerElo: document.getElementById('challengerElo'),
  challengerHp: document.getElementById('challengerHp'),
  challengerGen: document.getElementById('challengerGen'),
  challengerCard: document.getElementById('challengerCard'),
};

let DPR = 1;
let viewW = 0;
let viewH = 0;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  viewW = canvas.clientWidth;
  viewH = canvas.clientHeight;
  canvas.width = Math.floor(viewW * DPR);
  canvas.height = Math.floor(viewH * DPR);
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ state

let map = null;
let mapCanvas = null;
let mapW = 1000;
let mapH = 1000;
let snap = null;
let zone = null;

const renderBots = new Map();
const particles = [];
const floaters = [];
let killfeed = [];
let banner = null;
const focus = { x: 0, y: 0, w: 0 };
const cam = { x: 500, y: 500, zoom: 0.8 };
let shake = 0;
let lastFrameAt = performance.now();
let fps = 0;
let connected = false;

// ------------------------------------------------------------------ helpers

function decodeMap(data) {
  const raw = atob(data.tiles);
  const tiles = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) tiles[i] = raw.charCodeAt(i);
  return { ...data, tiles };
}

function buildMapCanvas(m) {
  const c = document.createElement('canvas');
  c.width = m.gw * m.tile;
  c.height = m.gh * m.tile;
  const g = c.getContext('2d');

  g.fillStyle = '#080e1a';
  g.fillRect(0, 0, c.width, c.height);

  // Faint floor grid so motion reads even on empty ground.
  g.strokeStyle = 'rgba(90, 130, 190, 0.07)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= m.gw; x++) {
    g.moveTo(x * m.tile + 0.5, 0);
    g.lineTo(x * m.tile + 0.5, c.height);
  }
  for (let y = 0; y <= m.gh; y++) {
    g.moveTo(0, y * m.tile + 0.5);
    g.lineTo(c.width, y * m.tile + 0.5);
  }
  g.stroke();

  for (let ty = 0; ty < m.gh; ty++) {
    for (let tx = 0; tx < m.gw; tx++) {
      const t = m.tiles[ty * m.gw + tx];
      if (!t) continue;
      const x = tx * m.tile;
      const y = ty * m.tile;
      const destructible = t === 2;
      g.fillStyle = destructible ? '#2b2136' : '#182338';
      g.fillRect(x, y, m.tile, m.tile);
      // top highlight, for a cheap sense of depth
      g.fillStyle = destructible ? 'rgba(190,120,255,0.30)' : 'rgba(120,170,240,0.22)';
      g.fillRect(x, y, m.tile, 2.5);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x, y + m.tile - 2.5, m.tile, 2.5);
    }
  }
  return c;
}

function setMap(data) {
  map = decodeMap(data);
  mapCanvas = buildMapCanvas(map);
  mapW = map.gw * map.tile;
  mapH = map.gh * map.tile;
  cam.x = mapW / 2;
  cam.y = mapH / 2;
  renderBots.clear();
  particles.length = 0;
  floaters.length = 0;
}

function shortestAngle(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function pushKillfeed(text, color) {
  killfeed.unshift({ text, color: color || '#cfd9ee', id: Math.random() });
  if (killfeed.length > 5) killfeed.pop();
  renderKillfeed();
}

function renderKillfeed() {
  el.killfeed.innerHTML = '';
  for (const k of killfeed) {
    const div = document.createElement('div');
    div.className = 'kf';
    div.style.borderLeftColor = k.color;
    div.textContent = k.text;
    el.killfeed.appendChild(div);
  }
}

function burst(x, y, color, count, speed, size) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.35 + Math.random());
    particles.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life: 0.28 + Math.random() * 0.4,
      maxLife: 0.68,
      color,
      size: size * (0.6 + Math.random() * 0.8),
    });
  }
}

// ---------------------------------------------------------------- messages

function syncBots(list) {
  const seen = new Set();
  for (const b of list) {
    seen.add(b.id);
    let r = renderBots.get(b.id);
    if (!r) {
      r = { x: b.x, y: b.y, angle: b.angle, tx: b.x, ty: b.y, targetAngle: b.angle };
      renderBots.set(b.id, r);
    }
    r.tx = b.x;
    r.ty = b.y;
    r.targetAngle = b.angle;
    r.name = b.name;
    r.color = b.color;
    r.health = b.health;
    r.maxHealth = b.maxHealth;
    r.alive = b.alive;
    r.reloading = b.reloading;
    r.hitFlash = b.hitFlash;
    r.danger = b.danger;
  }
  for (const id of [...renderBots.keys()]) {
    if (!seen.has(id)) renderBots.delete(id);
  }
}

function processEvents(events) {
  if (!events || events.length === 0) return;
  for (const e of events) {
    if (e.type === 'shot') {
      // Muzzle flash; the bullet itself is drawn from its own trail.
      particles.push({
        x: e.x,
        y: e.y,
        vx: 0,
        vy: 0,
        life: 0.08,
        maxLife: 0.08,
        color: '#ffe9a8',
        size: 5,
      });
      continue;
    }

    if (e.type === 'kill') {
      burst(e.x, e.y, e.color || '#ff8fa3', 26, 230, 3.2);
      shake = Math.min(14, shake + 7);
      focus.x = e.x;
      focus.y = e.y;
      focus.w = 1;
      pushKillfeed(e.text || 'kill', e.color || '#cfd9ee');
      continue;
    }

    if (e.type === 'death') {
      burst(e.x, e.y, e.color || '#ffffff', 34, 300, 3.6);
      shake = Math.min(18, shake + 9);
      continue;
    }

    if (e.type === 'pickup') {
      burst(e.x, e.y, e.color || '#3ddc97', 12, 90, 2.2);
      continue;
    }

    if (e.type === 'roundEnd') {
      banner = { text: e.text || 'round over', color: e.color || '#e9eefb', until: performance.now() + 2600 };
      continue;
    }

    if (e.type === 'hit') {
      if (e.text) {
        // zone warning / entry message
        pushKillfeed(e.text, e.color || '#ff5a5a');
        continue;
      }
      if (e.target !== undefined) {
        burst(e.x, e.y, e.color || '#ffd166', 8, 120, 2.4);
        floaters.push({ x: e.x, y: e.y, life: 0.7, color: e.color || '#ffd166' });
        shake = Math.min(12, shake + 1.6);
        focus.x = e.x;
        focus.y = e.y;
        focus.w = Math.max(focus.w, 0.5);
      } else {
        burst(e.x, e.y, 'rgba(180,200,230,0.9)', 4, 70, 1.6);
      }
    }
  }
}

function updateHud(info, bots) {
  el.gen.textContent = String(info.generation ?? 0);
  el.round.textContent = String(info.round ?? 1);
  el.defenses.textContent = String(info.defenses ?? 0);
  el.score.textContent = `${info.scoreboard?.champion ?? 0}–${info.scoreboard?.challenger ?? 0}`;
  el.tps.textContent = String(info.ticksPerSecond ?? 0);

  const champ = info.champion || { name: '—', elo: 0, generation: 0 };
  const chal = info.challenger || { name: '—', elo: 0, generation: 0 };
  el.championName.textContent = champ.name;
  el.championElo.textContent = String(champ.elo);
  el.championGen.textContent = String(champ.generation);
  el.challengerName.textContent = chal.name;
  el.challengerElo.textContent = String(chal.elo);
  el.challengerGen.textContent = String(chal.generation);

  const b0 = bots[0];
  const b1 = bots[1];
  if (b0) {
    el.championHp.style.width = `${Math.max(0, (b0.health / b0.maxHealth) * 100)}%`;
    el.championCard.classList.toggle('dead', !b0.alive);
  }
  if (b1) {
    el.challengerHp.style.width = `${Math.max(0, (b1.health / b1.maxHealth) * 100)}%`;
    el.challengerCard.classList.toggle('dead', !b1.alive);
  }
  if (zone) el.zoneR.textContent = String(Math.round(zone.r));
}

function onFrame(s) {
  if (!s) return;
  snap = s;
  zone = s.zone || null;
  syncBots(s.bots);
  processEvents(s.events);
  updateHud(s.info, s.bots);
}

// ------------------------------------------------------------------ stream

const source = new EventSource('/api/live');
source.addEventListener('hello', (ev) => {
  const d = JSON.parse(ev.data);
  setMap(d.map);
  onFrame(d.snapshot);
  connected = true;
  el.status.classList.add('hidden');
});
source.addEventListener('map', (ev) => {
  const d = JSON.parse(ev.data);
  setMap(d.map);
});
source.addEventListener('frame', (ev) => onFrame(JSON.parse(ev.data)));
source.addEventListener('error', () => {
  connected = false;
  el.status.classList.remove('hidden');
  el.status.innerHTML =
    'arena connection lost — retrying<br /><span style="font-size:0.7em">is the server still running?</span>';
});

// ------------------------------------------------------------------ render

function updateCamera(dt) {
  if (!map) return;
  const alive = [...renderBots.values()].filter((b) => b.alive);
  const actors = alive.length > 0 ? alive : [...renderBots.values()];
  if (actors.length === 0) return;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of actors) {
    minX = Math.min(minX, b.x);
    maxX = Math.max(maxX, b.x);
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y);
  }

  focus.w *= Math.pow(0.2, dt);
  if (focus.w > 0.05) {
    minX = Math.min(minX, focus.x - 60);
    maxX = Math.max(maxX, focus.x + 60);
    minY = Math.min(minY, focus.y - 60);
    maxY = Math.max(maxY, focus.y + 60);
  }

  // Prefer the closing safe zone as a framing hint late in the round.
  if (zone && zone.r < 320) {
    minX = Math.min(minX, zone.x - zone.r);
    maxX = Math.max(maxX, zone.x + zone.r);
    minY = Math.min(minY, zone.y - zone.r);
    maxY = Math.max(maxY, zone.y + zone.r);
  }

  const padX = 190;
  const padY = 210;
  const w = Math.max(320, maxX - minX + padX);
  const h = Math.max(320, maxY - minY + padY);
  const targetZoom = Math.max(0.42, Math.min(1.5, Math.min(viewW / w, viewH / h)));
  const targetX = (minX + maxX) / 2;
  const targetY = (minY + maxY) / 2;

  const k = Math.min(1, dt * 3.2);
  cam.zoom += (targetZoom - cam.zoom) * k;
  cam.x += (targetX - cam.x) * k;
  cam.y += (targetY - cam.y) * k;

  // Keep the camera inside the arena.
  const halfW = viewW / 2 / cam.zoom;
  const halfH = viewH / 2 / cam.zoom;
  if (mapW > halfW * 2) cam.x = Math.max(halfW, Math.min(mapW - halfW, cam.x));
  else cam.x = mapW / 2;
  if (mapH > halfH * 2) cam.y = Math.max(halfH, Math.min(mapH - halfH, cam.y));
  else cam.y = mapH / 2;
}

function drawBot(b, now) {
  if (!b) return;
  const r = b.alive ? 11 : 9;
  const alpha = b.alive ? 1 : 0.28;

  ctx.save();
  ctx.globalAlpha = alpha;

  // danger halo
  if (b.alive && b.danger) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 140);
    ctx.beginPath();
    ctx.arc(b.x, b.y, r + 7 + pulse * 3, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,60,60,${0.35 + pulse * 0.45})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // aim cone
  if (b.alive) {
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x + Math.cos(b.angle) * 26, b.y + Math.sin(b.angle) * 26);
    ctx.strokeStyle = `${b.color}88`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // body
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.fillStyle = b.alive ? b.color : '#3a4459';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();

  // muzzle direction pip
  ctx.beginPath();
  ctx.arc(b.x + Math.cos(b.angle) * r * 0.55, b.y + Math.sin(b.angle) * r * 0.55, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();

  // hit flash
  if (b.hitFlash > 0.01) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, b.hitFlash * 5)})`;
    ctx.fill();
  }

  // reload pip
  if (b.alive && b.reloading) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * 0.35);
    ctx.strokeStyle = 'rgba(255,209,102,0.9)';
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  // name + health bar
  if (b.alive) {
    const barW = 44;
    const barY = b.y - r - 13;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(b.x - barW / 2 - 1, barY - 1, barW + 2, 6);
    const hp = Math.max(0, b.health / b.maxHealth);
    ctx.fillStyle = hp > 0.55 ? '#3ddc97' : hp > 0.28 ? '#ffd166' : '#ff4d6d';
    ctx.fillRect(b.x - barW / 2, barY, barW * hp, 4);

    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(b.name, b.x + 1, barY - 6 + 1);
    ctx.fillStyle = b.color;
    ctx.fillText(b.name, b.x, barY - 6);
  }

  ctx.restore();
}

let lastTime = performance.now();
let frameCount = 0;
let fpsMark = performance.now();

function render(now) {
  requestAnimationFrame(render);
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  frameCount++;
  if (now - fpsMark > 500) {
    fps = Math.round((frameCount * 1000) / (now - fpsMark));
    frameCount = 0;
    fpsMark = now;
    el.fps.textContent = String(fps);
  }

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, viewW, viewH);
  if (!map) return;

  // --- smooth entities ---------------------------------------------------
  const k = Math.min(1, dt * 22);
  for (const b of renderBots.values()) {
    b.x += (b.tx - b.x) * k;
    b.y += (b.ty - b.y) * k;
    b.angle += shortestAngle(b.angle, b.targetAngle) * k;
  }

  updateCamera(dt);

  shake = Math.max(0, shake - dt * 34);
  const sx = shake > 0.01 ? (Math.random() - 0.5) * shake : 0;
  const sy = shake > 0.01 ? (Math.random() - 0.5) * shake : 0;

  ctx.save();
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x + sx, -cam.y + sy);

  // --- map ---------------------------------------------------------------
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(mapCanvas, 0, 0);

  // --- safe zone ---------------------------------------------------------
  if (zone && zone.r < mapW) {
    ctx.beginPath();
    ctx.rect(0, 0, mapW, mapH);
    ctx.moveTo(zone.x + zone.r, zone.y);
    ctx.arc(zone.x, zone.y, zone.r, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(255, 40, 60, 0.15)';
    ctx.fill('evenodd');

    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 90, 90, 0.8)';
    ctx.lineWidth = 2.5 / cam.zoom;
    ctx.stroke();
  }

  // --- pickups -----------------------------------------------------------
  if (snap && snap.pickups) {
    for (const p of snap.pickups) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 260 + p.x);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9 + pulse * 2, 0, Math.PI * 2);
      ctx.fillStyle = p.type === 0 ? 'rgba(61,220,151,0.85)' : 'rgba(255,209,102,0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.type === 0 ? '+' : 'A', p.x, p.y + 4);
    }
  }

  // --- bullets -----------------------------------------------------------
  if (snap && snap.bullets) {
    ctx.lineCap = 'round';
    for (const bl of snap.bullets) {
      ctx.beginPath();
      ctx.moveTo(bl.px, bl.py);
      ctx.lineTo(bl.x, bl.y);
      ctx.strokeStyle = 'rgba(255, 236, 160, 0.95)';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bl.x, bl.y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = '#fff8dc';
      ctx.fill();
    }
  }

  // --- particles ---------------------------------------------------------
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.94;
    p.vy *= 0.94;
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- bots --------------------------------------------------------------
  const bots = [...renderBots.values()];
  bots.sort((a, b) => (a.alive === b.alive ? 0 : a.alive ? 1 : -1));
  for (const b of bots) drawBot(b, now);

  // --- floating damage markers -------------------------------------------
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    if (f.life <= 0) {
      floaters.splice(i, 1);
      continue;
    }
    f.y -= dt * 26;
    ctx.globalAlpha = Math.min(1, f.life * 2);
    ctx.beginPath();
    ctx.arc(f.x, f.y, 3 + (1 - f.life / 0.7) * 7, 0, Math.PI * 2);
    ctx.strokeStyle = f.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  // --- banner ------------------------------------------------------------
  if (banner) {
    if (now > banner.until) {
      banner = null;
      el.banner.classList.remove('show');
    } else {
      el.banner.textContent = banner.text;
      el.banner.style.color = banner.color;
      el.banner.classList.add('show');
    }
  }
}

resize();
requestAnimationFrame(render);

// Keep the "connecting" overlay honest.
setTimeout(() => {
  if (!connected) el.status.classList.remove('hidden');
}, 1500);
