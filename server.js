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
const MAX_DOTS = 220;
const DOT_RADIUS = 6;
const BASE_RADIUS = 20;
const DOT_AREA_GAIN = 55; // area (not radius) added per dot eaten - gives natural diminishing growth
const BASE_SPEED = 4.2; // world units per tick at base size
const MIN_SPEED_FACTOR = 0.35; // biggest chickens never fully stop
const TICK_MS = 50; // 20 ticks/sec
const NAME_MAX_LEN = 16;
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac', '#63e6be'];

const players = new Map(); // ws -> player
const dots = new Map(); // id -> {id, x, y}
let nextDotId = 1;

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function spawnDot() {
  const id = nextDotId++;
  dots.set(id, { id, x: rand(20, WORLD_SIZE - 20), y: rand(20, WORLD_SIZE - 20) });
}

function ensureDots() {
  while (dots.size < MAX_DOTS) spawnDot();
}
ensureDots();

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

    // Dot collisions
    for (const dot of dots.values()) {
      const dist = Math.hypot(player.x - dot.x, player.y - dot.y);
      if (dist < player.radius) {
        dots.delete(dot.id);
        player.radius = radiusFromArea(areaFromRadius(player.radius) + DOT_AREA_GAIN);
        player.score += 1;
      }
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

