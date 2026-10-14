'use strict';
// Torneo de fósforos por absorción: el equipo que pierde se suma al que le ganó,
// y cada equipo decide su jugada votando. Reglas en relevamiento: ver README.md.
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const VOTE_MS = 20_000;          // F-09: 20 segundos para votar cada jugada
const REVEAL_MS = 2_500;         // F-20: se muestra la jugada votada antes de aplicarla
const MACHINE_MS = 1_400;        // lo que "piensa" la máquina
const NEXT_ROUND_MS = 6_000;     // pausa entre rondas
const LOBBY_GRACE_MS = 20_000;   // para recargar la página en la sala sin perder el lugar
const EMPTY_ROOM_MS = 10 * 60_000;
const MAX_PLAYERS = 60;
const STICKS_RANGE = [10, 30];   // F-12: sorteo de fósforos por ronda
const MAX_TAKE_RANGE = [2, 4];   // F-12: sorteo del máximo por turno por ronda
const MACHINE = 'MAQUINA';
const BOT_NAMES = ['Chispa', 'Mecha', 'Llamita', 'Brasa', 'Cerilla', 'Fogata', 'Yesca', 'Tizón', 'Pólvora', 'Bengala',
  'Ascua', 'Pabilo', 'Candil', 'Antorcha', 'Farol'];
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
const pick = (a) => a[crypto.randomInt(a.length)];
const randInt = (lo, hi) => lo + crypto.randomInt(hi - lo + 1);
const cleanName = (n) => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 18);
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
const other = (m, side) => (m.a === side ? m.b : m.a);

// ---------- MIN-MAX ----------
// ¿Gana quien tiene el turno con n fósforos y máximo k? (el que saca el último pierde)
const memo = new Map();
function wins(n, k) {
  if (n === 0) return true; // el rival sacó el último: ya ganó quien tiene el turno
  const key = `${n}:${k}`;
  if (memo.has(key)) return memo.get(key);
  let res = false;
  for (let t = 1; t <= Math.min(k, n) && !res; t++) if (!wins(n - t, k)) res = true;
  memo.set(key, res);
  return res;
}
function bestMove(n, k) {
  for (let t = 1; t <= Math.min(k, n); t++) if (!wins(n - t, k)) return t;
  return 1; // todas pierden: saca 1
}

// ---------- estado público ----------
function teamOf(r, pid) { return r.players.get(pid)?.teamId ?? null; }

function eligibleVoters(r, teamId) {
  const team = r.teams.get(teamId);
  if (!team) return [];
  return team.members.map((id) => r.players.get(id)).filter((p) => p && !p.left && (p.online || p.isBot));
}

function publicMatch(r, m, viewerTeam) {
  const { pendingAbsorb, ...rest } = m;
  const out = {
    ...rest,
    winningSide: m.status === 'playing' ? (wins(m.sticks, m.maxTake) ? m.turn : other(m, m.turn)) : null,
    vote: null,
  };
  if (m.vote) {
    const voters = Object.keys(m.vote.votes);
    out.vote = {
      deadline: m.vote.deadline,
      total: eligibleVoters(r, m.turn).length,
      voters,
      // los votos solo los ve el equipo que está votando
      votes: viewerTeam === m.turn ? m.vote.votes : null,
    };
  }
  return out;
}

function publicRoom(r, viewerId) {
  const viewerTeam = teamOf(r, viewerId);
  return {
    code: r.code,
    hostId: r.hostId,
    state: r.state,
    settings: r.settings,
    players: [...r.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, online: p.online, spectator: p.spectator,
      left: p.left, isBot: p.isBot, teamId: p.teamId,
    })),
    teams: [...r.teams.values()].map((t) => ({ id: t.id, captainId: t.captainId, color: t.color, members: t.members })),
    rounds: r.rounds.map((round) => ({ ...round, matches: round.matches.map((m) => publicMatch(r, m, viewerTeam)) })),
    currentRound: r.currentRound,
    champion: r.champion,
    nextRoundAt: r.nextRoundAt,
    tournamentNo: r.tournamentNo,
    serverNow: Date.now(),
  };
}

// cada jugador recibe su propia versión (para no mostrar los votos ajenos)
function broadcast(r) {
  for (const p of r.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', publicRoom(r, p.id));
  }
}

// ---------- jugadores ----------
function addPlayer(r, id, name) {
  const p = {
    id, name, color: COLORS[r.colorIdx++ % COLORS.length], online: true, socketId: null,
    spectator: false, left: false, isBot: false, teamId: null,
  };
  r.players.set(id, p);
  return p;
}
function addBot(r) {
  const used = new Set([...r.players.values()].map((p) => p.name.toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(`🤖 ${n}`.toLowerCase()));
  const name = `🤖 ${free.length ? pick(free) : `Bot ${r.players.size + 1}`}`;
  const p = addPlayer(r, `bot-${crypto.randomUUID()}`, name);
  p.isBot = true;
  return p;
}
const hasHumansOnline = (r) => [...r.players.values()].some((p) => p.online && !p.isBot);
function reassignHost(r) {
  const next = [...r.players.values()].find((p) => p.online && !p.left && !p.isBot);
  if (next) r.hostId = next.id;
}

// Los bots votan casi siempre la jugada de MIN-MAX, pero a veces se equivocan.
function botVote(m) {
  const best = bestMove(m.sticks, m.maxTake);
  if (!wins(m.sticks, m.maxTake) || crypto.randomInt(100) >= 75) return randInt(1, Math.min(m.maxTake, m.sticks));
  return best;
}

// ---------- torneo ----------
function sideInfo(r, side) {
  if (side === MACHINE) return { captainId: null, color: '#9aa4b2', members: [] };
  const t = r.teams.get(side);
  return { captainId: t.captainId, color: t.color, members: [...t.members] };
}
const sideSize = (r, side) => (side === MACHINE ? 1 : r.teams.get(side).members.length);

function newMatch(r, id, a, b, sticks, maxTake) {
  // F-13: empieza el equipo con menos integrantes; si tienen los mismos, sorteo
  const sa = sideSize(r, a);
  const sb = sideSize(r, b);
  const turn = sa < sb ? a : sb < sa ? b : pick([a, b]);
  return {
    id, a, b, info: { [a]: sideInfo(r, a), [b]: sideInfo(r, b) },
    sticks, initial: sticks, maxTake, turn, status: 'playing',
    winner: null, loser: null, vote: null, reveal: null, lastMove: null, history: [],
    absorbed: null, pendingAbsorb: false,
  };
}

function startRound(r) {
  r.nextRoundAt = null;
  const prev = r.rounds[r.rounds.length - 1];
  // F-12: fósforos y máximo sorteados, distintos en cada ronda
  const usedSticks = new Set(r.rounds.map((x) => x.sticks));
  const allSticks = STICKS_RANGE[1] - STICKS_RANGE[0] + 1;
  let sticks;
  do { sticks = randInt(...STICKS_RANGE); } while (usedSticks.has(sticks) && usedSticks.size < allSticks);
  let maxTake;
  do { maxTake = randInt(...MAX_TAKE_RANGE); } while (prev && maxTake === prev.maxTake);

  const ids = shuffle([...r.teams.keys()]);
  let machineTeam = null;
  if (ids.length % 2 === 1) {
    // F-11: el equipo que queda libre juega contra la máquina (le toca a quien menos veces le tocó)
    const min = Math.min(...ids.map((id) => r.teams.get(id).machineGames));
    machineTeam = pick(ids.filter((id) => r.teams.get(id).machineGames === min));
    ids.splice(ids.indexOf(machineTeam), 1);
    r.teams.get(machineTeam).machineGames++;
  }
  const no = r.rounds.length;
  const mid = (i) => `t${r.tournamentNo}r${no}m${i}`;
  const matches = [];
  for (let i = 0; i < ids.length; i += 2) matches.push(newMatch(r, mid(matches.length), ids[i], ids[i + 1], sticks, maxTake));
  if (machineTeam) matches.push(newMatch(r, mid(matches.length), machineTeam, MACHINE, sticks, maxTake));

  r.rounds.push({ no, sticks, maxTake, isFinal: r.teams.size === 2, matches });
  r.currentRound = no;
  for (const m of matches) startTurn(r, m);
}

function startTurn(r, m) {
  const key = `turn:${r.code}:${m.id}`;
  clearTimer(key);
  m.vote = null;
  if (m.turn === MACHINE) {
    setTimer(key, MACHINE_MS, () => applyTake(r, m, MACHINE, bestMove(m.sticks, m.maxTake), { how: 'machine' }));
    return;
  }
  // F-06 / F-09: el equipo vota durante 20 segundos
  m.vote = { deadline: Date.now() + VOTE_MS, votes: {} };
  setTimer(key, VOTE_MS, () => { closeVote(r, m); });
  for (const p of eligibleVoters(r, m.turn)) {
    if (p.isBot) setTimer(`bot:${r.code}:${m.id}:${p.id}`, randInt(1500, 7000), () => castVote(r, m, p.id, botVote(m)));
  }
}

function castVote(r, m, pid, n) {
  if (m.status !== 'playing' || !m.vote || teamOf(r, pid) !== m.turn) return;
  if (!Number.isInteger(n) || n < 1 || n > Math.min(m.maxTake, m.sticks)) return;
  m.vote.votes[pid] = n;
  if (!maybeCloseVote(r, m)) broadcast(r);
}

// Si ya votaron todos los que pueden votar, no hace falta esperar a que venza el tiempo.
function maybeCloseVote(r, m) {
  if (!m?.vote) return false;
  const voters = eligibleVoters(r, m.turn);
  if (voters.length && voters.every((p) => m.vote.votes[p.id] != null)) {
    closeVote(r, m);
    return true;
  }
  return false;
}

function closeVote(r, m) {
  if (!m.vote || m.status !== 'playing') return;
  const key = `turn:${r.code}:${m.id}`;
  clearTimer(key);
  for (const pid of Object.keys(m.vote.votes)) clearTimer(`bot:${r.code}:${m.id}:${pid}`);
  const tally = {};
  for (const v of Object.values(m.vote.votes)) tally[v] = (tally[v] || 0) + 1;
  const options = Object.keys(tally).map(Number);
  let n;
  let how;
  if (!options.length) {
    n = 1; how = 'none'; // nadie votó: se saca 1
  } else {
    const top = Math.max(...Object.values(tally));
    const tied = options.filter((o) => tally[o] === top).sort((x, y) => x - y);
    if (tied.length === 1) {
      n = tied[0]; how = 'majority'; // F-06: se juega lo que votó la mayoría
    } else {
      // F-08: el empate lo decide la máquina con MIN-MAX entre las opciones empatadas
      n = tied.find((t) => !wins(m.sticks - t, m.maxTake)) ?? tied[0];
      how = 'tiebreak';
    }
  }
  m.vote = null;
  m.reveal = { n, how, tally, until: Date.now() + REVEAL_MS };
  broadcast(r);
  // F-20: cada integrante ve la jugada ganadora antes de que se aplique
  setTimer(key, REVEAL_MS, () => {
    m.reveal = null;
    applyTake(r, m, m.turn, n, { how, tally });
  });
}

function applyTake(r, m, side, n, info) {
  if (m.status !== 'playing' || m.turn !== side) return;
  n = Math.min(n, m.sticks);
  m.sticks -= n;
  m.lastMove = { by: side, took: n, how: info.how, tally: info.tally ?? null, at: Date.now() };
  m.history.push(m.lastMove);
  if (m.sticks === 0) finishMatch(r, m, other(m, side), side);
  else { m.turn = other(m, side); startTurn(r, m); }
  broadcast(r);
}

function absorb(r, fromId, toId) {
  const from = r.teams.get(fromId);
  const to = r.teams.get(toId);
  for (const pid of from.members) {
    to.members.push(pid);
    const p = r.players.get(pid);
    if (p) p.teamId = toId;
  }
  r.teams.delete(fromId);
}

function finishMatch(r, m, winner, loser) {
  clearTimer(`turn:${r.code}:${m.id}`);
  Object.assign(m, { status: 'done', winner, loser, turn: null, vote: null, reveal: null });
  if (winner !== MACHINE && loser !== MACHINE) {
    // F-03: el que pierde se suma al equipo que le ganó
    m.absorbed = { into: winner, count: r.teams.get(loser).members.length };
    absorb(r, loser, winner);
  } else if (loser !== MACHINE) {
    m.pendingAbsorb = true; // perdió contra la máquina: se suma a un equipo al azar al cerrar la ronda
  }
  checkRoundEnd(r);
}

function checkRoundEnd(r) {
  const round = r.rounds[r.currentRound];
  // F-05: la ronda termina cuando terminaron todas sus partidas
  if (!round || round.matches.some((m) => m.status === 'playing')) return;
  for (const m of round.matches) {
    if (!m.pendingAbsorb) continue;
    m.pendingAbsorb = false;
    const others = [...r.teams.keys()].filter((id) => id !== m.loser);
    if (r.teams.has(m.loser) && others.length) {
      const into = pick(others);
      m.absorbed = { into, count: r.teams.get(m.loser).members.length, intoCaptainId: r.teams.get(into).captainId };
      absorb(r, m.loser, into);
    }
  }
  if (r.teams.size <= 1) return finishTournament(r);
  r.nextRoundAt = Date.now() + NEXT_ROUND_MS;
  setTimer(`next:${r.code}`, NEXT_ROUND_MS, () => {
    startRound(r);
    broadcast(r);
  });
}

function finishTournament(r) {
  // F-15: el equipo campeón con todos sus integrantes
  const team = [...r.teams.values()][0];
  r.state = 'finished';
  r.champion = team ? { teamId: team.id, captainId: team.captainId, color: team.color, members: [...team.members] } : null;
  r.nextRoundAt = null;
  clearRoomTimers(r.code);
}

function resetToLobby(r) {
  clearRoomTimers(r.code);
  for (const p of [...r.players.values()]) {
    if (!p.online || p.left) { r.players.delete(p.id); continue; }
    Object.assign(p, { spectator: false, teamId: null });
  }
  r.teams = new Map();
  Object.assign(r, { state: 'lobby', rounds: [], currentRound: -1, champion: null, nextRoundAt: null });
  if (!r.players.get(r.hostId)?.online) reassignHost(r);
}

function currentMatchOfTeam(r, teamId) {
  return r.rounds[r.currentRound]?.matches.find((m) => m.status === 'playing' && m.turn === teamId) ?? null;
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
    clearTimer(`dc:${r.code}:${p.id}`);
    clearTimer(`room:${r.code}`);
  }

  function detach(explicit) {
    const r = room, p = me;
    room = null; me = null;
    if (!r || !p || p.socketId !== socket.id) return;
    p.online = false;
    p.socketId = null;
    if (explicit) {
      if (r.state === 'lobby' || p.spectator) r.players.delete(p.id);
      else p.left = true;
      if (r.hostId === p.id) reassignHost(r);
    } else if (r.state === 'lobby') {
      setTimer(`dc:${r.code}:${p.id}`, LOBBY_GRACE_MS, () => {
        if (p.online || r.state !== 'lobby') return;
        r.players.delete(p.id);
        if (r.hostId === p.id) reassignHost(r);
        broadcast(r);
      });
    }
    if (!explicit && r.hostId === p.id) {
      setTimer(`host:${r.code}`, 10_000, () => {
        if (!r.players.get(r.hostId)?.online) { reassignHost(r); broadcast(r); }
      });
    }
    // si se fue alguien de un equipo que está votando, puede que ya hayan votado todos los demás
    if (r.state === 'playing' && p.teamId) maybeCloseVote(r, currentMatchOfTeam(r, p.teamId));
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
      code: newCode(), hostId: playerId, players: new Map(), teams: new Map(), colorIdx: crypto.randomInt(COLORS.length),
      // F-02: quien crea el torneo lo organiza; por defecto no juega
      settings: { hostPlays: !!data?.hostPlays },
      state: 'lobby', rounds: [], currentRound: -1, champion: null, nextRoundAt: null, tournamentNo: 0,
    };
    rooms.set(r.code, r);
    attach(r, addPlayer(r, playerId, name));
    if (data?.bots) for (let i = 0; i < Math.min(8, Number(data.bots) || 0); i++) addBot(r);
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
    // F-02: una vez iniciado el torneo no se inscribe nadie más (puede entrar solo a mirar)
    if (r.state !== 'lobby') p.spectator = true;
    attach(r, p);
    ack({ ok: true, code, spectator: p.spectator });
    broadcast(r);
  });

  socket.on('settings', (s) => {
    if (!isHost() || room.state !== 'lobby' || !s) return;
    if (typeof s.hostPlays === 'boolean') room.settings.hostPlays = s.hostPlays;
    broadcast(room);
  });

  socket.on('addBot', (count) => {
    if (!isHost() || room.state !== 'lobby') return;
    const n = Math.min(8, Math.max(1, Number(count) || 1));
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
    sock?.emit('kicked');
    broadcast(room);
  });

  socket.on('start', () => {
    if (!isHost() || room.state !== 'lobby') return;
    for (const p of [...room.players.values()]) {
      if (!p.online) { room.players.delete(p.id); clearTimer(`dc:${room.code}:${p.id}`); }
    }
    const participants = [...room.players.values()].filter((p) => p.id !== room.hostId || room.settings.hostPlays);
    if (participants.length < 2) return;
    room.state = 'playing';
    room.tournamentNo++;
    room.rounds = [];
    room.champion = null;
    room.teams = new Map();
    // cada inscripto arranca como un equipo de un integrante, y es su capitán
    for (const p of participants) {
      const id = `T${room.tournamentNo}-${room.teams.size + 1}`;
      room.teams.set(id, { id, captainId: p.id, color: p.color, members: [p.id], machineGames: 0 });
      p.teamId = id;
    }
    const host = room.players.get(room.hostId);
    if (!room.settings.hostPlays) host.spectator = true;
    startRound(room);
    broadcast(room);
  });

  socket.on('vote', (n) => {
    if (!ok() || room.state !== 'playing' || !me.teamId) return;
    const m = currentMatchOfTeam(room, me.teamId);
    if (m) castVote(room, m, me.id, Number(n));
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
