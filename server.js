// Glow Chicken - a tiny .io-style multiplayer game. One Node process serves the
// single HTML page AND runs a WebSocket game loop, so it only needs one exposed
// port - deploy-anywhere friendly for free hosts. No database: the whole game
// world lives in memory and resets if the process restarts (that's fine, it's a
// casual party game, not something anyone needs to persist).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---- constants -------------------------------------------------------
const WORLD_SIZE = 3000;
const MAX_DOTS = 450; // much denser field of dots
const BASE_RADIUS = 20;
const BASE_SPEED = 6.3; // world units per tick at base size (50% faster than the original 4.2)
const MIN_SPEED_FACTOR = 0.35; // biggest chickens never fully stop
const TICK_MS = 50; // 20 ticks/sec
const NAME_MAX_LEN = 16;
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac', '#63e6be'];

// ---- player-vs-player bumping ------------------------------------------
// A bigger chicken that touches a smaller one "bumps" it: the smaller one
// drops a quarter of its glow onto the map as a burst of collectible dots,
// which the bumper (or anyone else nearby) can then scoop up. A short
// immunity window after being bumped stops one big chicken from parked-on
// top of a small one draining it every single tick.
const BUMP_DROP_FRACTION = 0.25;
const BUMP_IMMUNITY_MS = 1200;
const MIN_PLAYER_RADIUS = 12; // a bumped chicken never shrinks below this
const DROPPED_DOT_COLOR = '#ffffff';
const DROPPED_DOT_RADIUS = 9;

// Dots come in tiers - bigger dots are rarer, glow a different color, and are
// worth a lot more growth (area gain), so hunting down the big glowing ones
// is worth the risk of crossing the map for them.
const DOT_TIERS = [
  { radius: 6, color: '#fff59d', areaGain: 55, weight: 58 }, // common - pale yellow
  { radius: 10, color: '#4dabf7', areaGain: 140, weight: 24 }, // uncommon - blue
  { radius: 15, color: '#9775fa', areaGain: 300, weight: 13 }, // rare - purple
  { radius: 21, color: '#ff6b6b', areaGain: 550, weight: 5 }, // epic - red, biggest payoff
];
const DOT_WEIGHT_TOTAL = DOT_TIERS.reduce((sum, t) => sum + t.weight, 0);

const players = new Map(); // ws -> player
const dots = new Map(); // id -> {id, x, y, r, c, gain}
let nextDotId = 1;

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function pickDotTier() {
  let roll = Math.random() * DOT_WEIGHT_TOTAL;
  for (const tier of DOT_TIERS) {
    roll -= tier.weight;
    if (roll <= 0) return tier;
  }
  return DOT_TIERS[0];
}

function spawnDot() {
  const id = nextDotId++;
  const tier = pickDotTier();
  dots.set(id, {
    id,
    x: rand(20, WORLD_SIZE - 20),
    y: rand(20, WORLD_SIZE - 20),
    r: tier.radius,
    c: tier.color,
    gain: tier.areaGain,
  });
}

function ensureDots() {
  while (dots.size < MAX_DOTS) spawnDot();
}
ensureDots();

// Scatters a burst of white "dropped glow" dots around (x, y) whose combined
// gain adds up to totalGain - this is how a bumped player's stolen glow
// actually gets back onto the map for someone to pick up.
function scatterDroppedGlow(x, y, totalGain) {
  const count = Math.max(3, Math.min(10, Math.round(totalGain / 45)));
  const gainEach = totalGain / count;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spread = rand(10, 60);
    const id = nextDotId++;
    dots.set(id, {
      id,
      x: Math.max(10, Math.min(WORLD_SIZE - 10, x + Math.cos(angle) * spread)),
      y: Math.max(10, Math.min(WORLD_SIZE - 10, y + Math.sin(angle) * spread)),
      r: DROPPED_DOT_RADIUS,
      c: DROPPED_DOT_COLOR,
      gain: gainEach,
    });
  }
}

function radiusFromArea(area) {
  return Math.sqrt(area / Math.PI);
}
function areaFromRadius(r) {
  return Math.PI * r * r;
}

function spawnPlayer(name, color) {
  return {
    name: (name || 'Chicken').slice(0, NAME_MAX_LEN),
    color: color || randomColor(),
    x: rand(200, WORLD_SIZE - 200),
    y: rand(200, WORLD_SIZE - 200),
    targetX: null,
    targetY: null,
    radius: BASE_RADIUS,
    score: 0,
    joinedAt: Date.now(),
    bumpImmuneUntil: 0,
  };
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of players.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function tick() {
  for (const [ws, player] of players) {
    if (player.targetX !== null && player.targetY !== null) {
      const dx = player.targetX - player.x;
      const dy = player.targetY - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1) {
        const speedFactor = Math.max(MIN_SPEED_FACTOR, BASE_RADIUS / player.radius);
        const speed = Math.min(dist, BASE_SPEED * speedFactor);
        player.x += (dx / dist) * speed;
        player.y += (dy / dist) * speed;
        player.x = Math.max(player.radius, Math.min(WORLD_SIZE - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(WORLD_SIZE - player.radius, player.y));
      }
    }

    // Dot collisions - catch radius includes the dot's own size, so bigger
    // (more valuable) dots are also a bit easier to reach.
    for (const dot of dots.values()) {
      const dist = Math.hypot(player.x - dot.x, player.y - dot.y);
      if (dist < player.radius + dot.r) {
        dots.delete(dot.id);
        player.radius = radiusFromArea(areaFromRadius(player.radius) + dot.gain);
        player.score += 1;
      }
    }
  }

  // Player-vs-player bumps: a bigger chicken touching a smaller one steals
  // 25% of the smaller one's glow, dropped onto the map as pickups.
  const playerArr = [...players.values()];
  const now = Date.now();
  for (let i = 0; i < playerArr.length; i++) {
    for (let j = i + 1; j < playerArr.length; j++) {
      const a = playerArr[i];
      const b = playerArr[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist >= a.radius + b.radius) continue; // not touching

      const bigger = a.radius >= b.radius ? a : b;
      const smaller = bigger === a ? b : a;
      if (bigger.radius <= smaller.radius) continue; // same size - no bump
      if (now < smaller.bumpImmuneUntil) continue; // still recovering

      const smallerArea = areaFromRadius(smaller.radius);
      const floorArea = areaFromRadius(MIN_PLAYER_RADIUS);
      const dropAmount = Math.min(smallerArea * BUMP_DROP_FRACTION, Math.max(0, smallerArea - floorArea));
      if (dropAmount <= 0) continue;

      smaller.radius = radiusFromArea(smallerArea - dropAmount);
      smaller.bumpImmuneUntil = now + BUMP_IMMUNITY_MS;
      scatterDroppedGlow(smaller.x, smaller.y, dropAmount);
    }
  }

  ensureDots();

  const playerList = [...players.values()].map((p, i) => ({
    id: playerIdOf(p),
    name: p.name,
    color: p.color,
    x: Math.round(p.x),
    y: Math.round(p.y),
    r: Math.round(p.radius * 10) / 10,
    score: p.score,
  }));

  broadcast({
    t: 'state',
    players: playerList,
    dots: [...dots.values()],
  });
}

const idByPlayer = new WeakMap();
let nextPlayerId = 1;
function playerIdOf(player) {
  if (!idByPlayer.has(player)) idByPlayer.set(player, `p${nextPlayerId++}`);
  return idByPlayer.get(player);
}

setInterval(tick, TICK_MS);

// ---- static file serving ----------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0];
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fullPath)] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === 'join') {
      const player = spawnPlayer(msg.name, msg.color);
      players.set(ws, player);
      ws.send(JSON.stringify({ t: 'welcome', id: playerIdOf(player), worldSize: WORLD_SIZE, you: { x: player.x, y: player.y, radius: player.radius } }));
      return;
    }

    if (msg.t === 'input') {
      const player = players.get(ws);
      if (!player) return;
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        player.targetX = Math.max(0, Math.min(WORLD_SIZE, msg.x));
        player.targetY = Math.max(0, Math.min(WORLD_SIZE, msg.y));
      }
    }
  });

  ws.on('close', () => {
    players.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Glow Chicken listening on port ${PORT}`);
});
