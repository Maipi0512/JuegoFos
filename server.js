'use strict';
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const LOBBY_GRACE_MS = 20_000;   // tiempo para recargar la página en el lobby sin perder el lugar
const MATCH_GRACE_MS = 30_000;   // si te desconectás en plena partida y no volvés, perdés
const NEXT_ROUND_MS = 5_000;     // pausa entre rondas
const EMPTY_ROOM_MS = 10 * 60_000;
const MAX_PLAYERS = 32;
const BOT_NAMES = ['Chispa', 'Mecha', 'Llamita', 'Brasa', 'Cerilla', 'Fogata', 'Yesca', 'Tizón', 'Pólvora', 'Bengala'];
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7',
  '#748ffc', '#da77f2', '#f783ac', '#a9e34b', '#63e6be', '#e599f7'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// IPs de la red local (se ignoran VPNs, Docker, etc.) para armar el link de invitación
function lanAddresses() {
  const out = [];
  for (const [name, nets] of Object.entries(os.networkInterfaces())) {
    if (/warp|tun|tap|wg|docker|br-|veth|vbox|vmnet|zt/i.test(name)) continue;
    for (const n of nets ?? []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}
app.get('/info', (req, res) => {
  const ip = lanAddresses()[0];
  res.json({ lanOrigin: ip ? `http://${ip}:${PORT}` : null });
});

const rooms = new Map();
const timers = new Map();

// ---------- utilidades ----------
function setTimer(key, ms, fn) {
  clearTimer(key);
  timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms));
}
function clearTimer(key) {
  const t = timers.get(key);
  if (t) { clearTimeout(t); timers.delete(key); }
}
function clearRoomTimers(code, includeRoom = false) {
  for (const key of [...timers.keys()]) {
    const [type, c] = key.split(':');
    if (c === code && (includeRoom || type !== 'room')) clearTimer(key);
  }
}
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const cleanName = (n) => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 18);
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
const clamp = (n, lo, hi, def) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def);
function roundsFor(n) { let t = 0; while (n > 1) { n = Math.ceil(n / 2); t++; } return t; }
const other = (m, pid) => (m.p1 === pid ? m.p2 : m.p1);

function publicRoom(r) {
  return {
    code: r.code,
    hostId: r.hostId,
    state: r.state,
    settings: r.settings,
    players: [...r.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, online: p.online,
      eliminated: p.eliminated, spectator: p.spectator, left: p.left, wins: p.wins, isBot: p.isBot,
    })),
    rounds: r.rounds,
    currentRound: r.currentRound,
    totalRounds: Math.max(r.totalRounds, r.rounds.length),
    championId: r.championId,
    nextRoundAt: r.nextRoundAt,
    tournamentNo: r.tournamentNo,
    serverNow: Date.now(),
  };
}
const broadcast = (r) => io.to(r.code).emit('state', publicRoom(r));

function addPlayer(r, id, name) {
  const p = {
    id, name, color: COLORS[r.colorIdx++ % COLORS.length], online: true, socketId: null,
    eliminated: false, spectator: false, left: false, wins: 0, byes: 0,
  };
  r.players.set(id, p);
  return p;
}
function addBot(r) {
  const used = new Set([...r.players.values()].map((p) => p.name.toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(`🤖 ${n}`.toLowerCase()));
  const name = `🤖 ${free.length ? free[crypto.randomInt(free.length)] : `Bot ${r.players.size + 1}`}`;
  const p = addPlayer(r, `bot-${crypto.randomUUID()}`, name);
  p.isBot = true;
  return p;
}
const hasHumansOnline = (r) => [...r.players.values()].some((p) => p.online && !p.isBot);

// Juega casi siempre perfecto (dejar al rival con n ≡ 1 mod (k+1)), pero a veces se equivoca para que se le pueda ganar.
function botMove(r, m) {
  const k = r.settings.maxTake;
  const best = (m.sticks - 1) % (k + 1);
  if (best > 0 && crypto.randomInt(100) < 75) return best;
  return 1 + crypto.randomInt(Math.min(k, m.sticks));
}

function reassignHost(r) {
  const next = [...r.players.values()].find((p) => p.online && !p.left && !p.isBot);
  if (next) r.hostId = next.id;
}
function activeMatchOf(r, pid) {
  const round = r.rounds[r.currentRound];
  return round?.find((m) => m.status === 'playing' && (m.p1 === pid || m.p2 === pid)) ?? null;
}

// ---------- torneo ----------
function newMatch(r, id, p1, p2) {
  const sticks = r.settings.randomSticks ? 10 + crypto.randomInt(16) : r.settings.sticks;
  return {
    id, p1, p2, status: 'playing', sticks, initial: sticks,
    turn: crypto.randomInt(2) ? p1 : p2,
    winner: null, loser: null, reason: null, history: [], lastMove: null, turnDeadline: null,
  };
}

function startRound(r, ids) {
  r.nextRoundAt = null;
  ids = ids.slice();
  let byeId = null;
  if (ids.length % 2 === 1) {
    // pase libre para quien tuvo menos pases; en empate, el último de la lista
    for (const id of ids) {
      if (!byeId || r.players.get(id).byes <= r.players.get(byeId).byes) byeId = id;
    }
    ids.splice(ids.indexOf(byeId), 1);
  }
  const roundNo = r.rounds.length;
  const mid = (i) => `t${r.tournamentNo}r${roundNo}m${i}`;
  const matches = [];
  for (let i = 0; i < ids.length; i += 2) matches.push(newMatch(r, mid(matches.length), ids[i], ids[i + 1]));
  if (byeId) {
    r.players.get(byeId).byes++;
    matches.push({
      id: mid(matches.length), p1: byeId, p2: null, status: 'bye', sticks: 0, initial: 0, turn: null,
      winner: byeId, loser: null, reason: 'bye', history: [], lastMove: null, turnDeadline: null,
    });
  }
  r.rounds.push(matches);
  r.currentRound = roundNo;
  for (const m of matches) {
    if (m.status !== 'playing') continue;
    scheduleTurn(r, m);
    for (const pid of [m.p1, m.p2]) if (!r.players.get(pid).online) scheduleForfeit(r, pid);
  }
}

function scheduleTurn(r, m) {
  if (r.players.get(m.turn)?.isBot) {
    setTimer(`bot:${r.code}:${m.id}`, 900 + crypto.randomInt(1200), () => applyTake(r, m, m.turn, botMove(r, m)));
  }
  const secs = r.settings.turnSeconds;
  const key = `turn:${r.code}:${m.id}`;
  if (!secs) { m.turnDeadline = null; clearTimer(key); return; }
  m.turnDeadline = Date.now() + secs * 1000;
  setTimer(key, secs * 1000 + 250, () => {
    if (m.status === 'playing') applyTake(r, m, m.turn, 1, true);
  });
}

function applyTake(r, m, pid, n, auto = false) {
  if (m.status !== 'playing' || m.turn !== pid) return false;
  if (!Number.isInteger(n) || n < 1 || n > r.settings.maxTake || n > m.sticks) return false;
  m.sticks -= n;
  m.lastMove = { by: pid, took: n, auto, at: Date.now() };
  m.history.push(m.lastMove);
  if (m.sticks === 0) finishMatch(r, m, other(m, pid), pid, 'last');
  else { m.turn = other(m, pid); scheduleTurn(r, m); }
  broadcast(r);
  return true;
}

function finishMatch(r, m, winner, loser, reason) {
  clearTimer(`turn:${r.code}:${m.id}`);
  Object.assign(m, { status: 'done', winner, loser, reason, turn: null, turnDeadline: null });
  r.players.get(loser).eliminated = true;
  r.players.get(winner).wins++;
  checkRoundEnd(r);
}

function checkRoundEnd(r) {
  const round = r.rounds[r.currentRound];
  if (!round || round.some((m) => m.status === 'playing')) return;
  const alive = () => round.map((m) => m.winner).filter((id) => {
    const p = r.players.get(id);
    return p && !p.eliminated;
  });
  if (alive().length <= 1) return finishTournament(r, alive()[0] ?? null);
  r.nextRoundAt = Date.now() + NEXT_ROUND_MS;
  setTimer(`next:${r.code}`, NEXT_ROUND_MS, () => {
    const ids = alive();
    if (ids.length <= 1) finishTournament(r, ids[0] ?? null);
    else startRound(r, ids);
    broadcast(r);
  });
}

function finishTournament(r, championId) {
  r.state = 'finished';
  r.championId = championId;
  r.nextRoundAt = null;
  clearRoomTimers(r.code);
}

function scheduleForfeit(r, pid) {
  setTimer(`dc:${r.code}:${pid}`, MATCH_GRACE_MS, () => {
    const p = r.players.get(pid);
    if (p && !p.online && r.state === 'playing') { forfeit(r, pid, 'disconnect'); broadcast(r); }
  });
}

function forfeit(r, pid, reason) {
  const p = r.players.get(pid);
  if (!p || r.state !== 'playing') return;
  const m = activeMatchOf(r, pid);
  if (m) return finishMatch(r, m, other(m, pid), pid, reason);
  if (!p.spectator) {
    p.eliminated = true;
    checkRoundEnd(r);
  }
}

function resetToLobby(r) {
  clearRoomTimers(r.code);
  for (const p of [...r.players.values()]) {
    if (!p.online || p.left) { r.players.delete(p.id); continue; }
    Object.assign(p, { eliminated: false, spectator: false, byes: 0 });
  }
  Object.assign(r, { state: 'lobby', rounds: [], currentRound: -1, totalRounds: 0, championId: null, nextRoundAt: null });
  if (!r.players.get(r.hostId)?.online) reassignHost(r);
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  let room = null;
  let me = null;
  const ok = () => room && me && me.socketId === socket.id;
  const isHost = () => ok() && room.hostId === me.id;

  function attach(r, p) {
    if (room && (room !== r || me !== p)) detach(false);
    if (p.socketId && p.socketId !== socket.id) io.sockets.sockets.get(p.socketId)?.emit('replaced');
    room = r; me = p;
    Object.assign(p, { socketId: socket.id, online: true, left: false });
    socket.join(r.code);
    clearTimer(`dc:${r.code}:${p.id}`);
    clearTimer(`room:${r.code}`);
  }

  function detach(explicit) {
    const r = room, p = me;
    room = null; me = null;
    if (!r || !p) return;
    socket.leave(r.code);
    if (p.socketId !== socket.id) return;
    p.online = false;
    p.socketId = null;
    if (explicit) {
      clearTimer(`dc:${r.code}:${p.id}`);
      if (r.state === 'lobby' || p.spectator) r.players.delete(p.id);
      else { p.left = true; forfeit(r, p.id, 'left'); }
      if (r.hostId === p.id) reassignHost(r);
    } else {
      if (r.state === 'lobby') {
        setTimer(`dc:${r.code}:${p.id}`, LOBBY_GRACE_MS, () => {
          if (p.online || r.state !== 'lobby') return;
          r.players.delete(p.id);
          if (r.hostId === p.id) reassignHost(r);
          broadcast(r);
        });
      } else if (r.state === 'playing' && activeMatchOf(r, p.id)) {
        scheduleForfeit(r, p.id);
      }
      if (r.hostId === p.id) {
        setTimer(`host:${r.code}`, 10_000, () => {
          if (!r.players.get(r.hostId)?.online) { reassignHost(r); broadcast(r); }
        });
      }
    }
    if (!hasHumansOnline(r)) {
      setTimer(`room:${r.code}`, EMPTY_ROOM_MS, () => { clearRoomTimers(r.code, true); rooms.delete(r.code); });
    }
    broadcast(r);
  }

  socket.on('create', (data, ack) => {
    if (typeof ack !== 'function') return;
    const name = cleanName(data?.name);
    const playerId = data?.playerId;
    if (!validId(playerId)) return ack({ error: 'Identificador inválido, recargá la página' });
    if (!name) return ack({ error: 'Poné un nombre' });
    const r = {
      code: newCode(), hostId: playerId, players: new Map(), colorIdx: crypto.randomInt(COLORS.length),
      settings: { sticks: 15, randomSticks: false, maxTake: 2, turnSeconds: 20 },
      state: 'lobby', rounds: [], currentRound: -1, totalRounds: 0, championId: null,
      nextRoundAt: null, tournamentNo: 0,
    };
    rooms.set(r.code, r);
    attach(r, addPlayer(r, playerId, name));
    ack({ ok: true, code: r.code });
    broadcast(r);
  });

  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    const code = String(data?.code ?? '').toUpperCase().trim();
    const playerId = data?.playerId;
    if (!validId(playerId)) return ack({ error: 'Identificador inválido, recargá la página' });
    const r = rooms.get(code);
    if (!r) return ack({ error: 'No existe una sala con ese código' });
    const existing = r.players.get(playerId);
    if (existing) {
      attach(r, existing);
      ack({ ok: true, code });
      return broadcast(r);
    }
    const name = cleanName(data?.name);
    if (!name) return ack({ error: 'Poné un nombre' });
    if (r.players.size >= MAX_PLAYERS) return ack({ error: 'La sala está llena' });
    if ([...r.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return ack({ error: 'Ese nombre ya está en uso en la sala' });
    }
    const p = addPlayer(r, playerId, name);
    if (r.state !== 'lobby') p.spectator = true;
    attach(r, p);
    ack({ ok: true, code });
    broadcast(r);
  });

  socket.on('settings', (s) => {
    if (!isHost() || room.state !== 'lobby' || !s) return;
    const cur = room.settings;
    const turnOptions = [0, 10, 20, 30];
    room.settings = {
      sticks: clamp(Number(s.sticks), 5, 40, cur.sticks),
      randomSticks: typeof s.randomSticks === 'boolean' ? s.randomSticks : cur.randomSticks,
      maxTake: clamp(Number(s.maxTake), 2, 4, cur.maxTake),
      turnSeconds: turnOptions.includes(Number(s.turnSeconds)) ? Number(s.turnSeconds) : cur.turnSeconds,
    };
    broadcast(room);
  });

  socket.on('addBot', (count) => {
    if (!isHost() || room.state !== 'lobby') return;
    const n = clamp(Number(count), 1, 8, 1);
    for (let i = 0; i < n && room.players.size < MAX_PLAYERS; i++) addBot(room);
    broadcast(room);
  });

  socket.on('kick', (pid) => {
    if (!isHost() || room.state !== 'lobby' || pid === me.id) return;
    const target = room.players.get(pid);
    if (!target) return;
    const sock = target.socketId && io.sockets.sockets.get(target.socketId);
    target.socketId = null;
    room.players.delete(pid);
    clearTimer(`dc:${room.code}:${pid}`);
    if (sock) { sock.emit('kicked'); sock.leave(room.code); }
    broadcast(room);
  });

  socket.on('start', () => {
    if (!isHost() || room.state !== 'lobby') return;
    for (const p of [...room.players.values()]) {
      if (!p.online) { room.players.delete(p.id); clearTimer(`dc:${room.code}:${p.id}`); }
    }
    const ids = [...room.players.keys()];
    if (ids.length < 2) return;
    room.state = 'playing';
    room.tournamentNo++;
    room.rounds = [];
    room.championId = null;
    room.totalRounds = roundsFor(ids.length);
    startRound(room, shuffle(ids));
    broadcast(room);
  });

  socket.on('take', (n) => {
    if (!ok() || room.state !== 'playing') return;
    const m = activeMatchOf(room, me.id);
    if (m) applyTake(room, m, me.id, Number(n));
  });

  socket.on('restart', () => {
    if (!isHost() || room.state === 'lobby') return;
    resetToLobby(room);
    broadcast(room);
  });

  socket.on('leave', () => detach(true));
  socket.on('disconnect', () => detach(false));
});

server.listen(PORT, () => {
  console.log(`\n🔥 Fósforos corriendo en http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`   En tu red local: http://${ip}:${PORT}  ← pasales este a tus amigos`);
  console.log('');
});
