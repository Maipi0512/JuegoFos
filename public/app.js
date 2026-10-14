'use strict';
const socket = io();
const $ = (s, el = document) => el.querySelector(s);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin storage */ } },
};
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* sin storage */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* sin storage */ } },
};

// id por pestaña, así se puede probar con varias pestañas en la misma compu
const myId = session.get('fosforos.id') || (() => {
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  session.set('fosforos.id', id);
  return id;
})();

let room = null;
let clockOffset = 0;
let focusId = null;
let wasMyTurn = false;
let championShown = null;
let championDismissed = null;
const views = new Map();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const P = (id) => room?.players.find((p) => p.id === id);
const nameOf = (id) => P(id)?.name ?? '—';
const now = () => Date.now() + clockOffset;
const avatar = (p, cls = '') => (p
  ? `<span class="avatar ${cls}" style="--c:${p.color}">${p.isBot ? '🤖' : esc(p.name[0].toUpperCase())}</span>`
  : `<span class="avatar ghost ${cls}">?</span>`);

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

// ---------------- audio ----------------
let actx = null;
let sfxOn = store.get('fosforos.sfx') !== '0';
let musicOn = store.get('fosforos.music') !== '0';

function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function syncMusic() {
  if (!actx) return;
  if (musicOn) Music.start(actx);
  else Music.stop();
  Music.setMood(room && room.state === 'playing' ? 'tense' : 'calm');
}
// los navegadores solo dejan sonar audio después de un gesto del usuario
const unlockAudio = () => { if (audio()) syncMusic(); };
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function sfxStrike() {
  const a = sfxOn && audio();
  if (!a) return;
  const dur = 0.4;
  const buf = a.createBuffer(1, a.sampleRate * dur, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const x = i / d.length;
    d[i] = (Math.random() * 2 - 1) * (x < 0.12 ? 1 : Math.pow(1 - x, 2) * 0.5);
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(3500, a.currentTime);
  f.frequency.exponentialRampToValueAtTime(600, a.currentTime + dur);
  const g = a.createGain();
  g.gain.value = 0.5;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}
function tone(freq, t, dur, vol = 0.15, type = 'sine') {
  const a = actx;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}
function sfxNotes(notes, step = 0.12, type = 'triangle') {
  const a = sfxOn && audio();
  if (!a) return;
  notes.forEach((f, i) => tone(f, a.currentTime + i * step, 0.35, 0.14, type));
}
const sfxTurn = () => sfxNotes([660, 990], 0.1, 'sine');
const sfxWin = () => sfxNotes([523, 659, 784, 1047], 0.11);
const sfxLose = () => sfxNotes([392, 330, 262], 0.18, 'sine');
const sfxFanfare = () => sfxNotes([523, 659, 784, 1047, 784, 1047, 1319], 0.13);

function renderAudioButtons() {
  const html = `
    <button class="icon-btn ${musicOn ? '' : 'off'}" data-audio="music" title="Música">${musicOn ? '🎵' : '🔇'}</button>
    <button class="icon-btn ${sfxOn ? '' : 'off'}" data-audio="sfx" title="Efectos de sonido">${sfxOn ? '🔊' : '🔈'}</button>`;
  for (const el of document.querySelectorAll('.audio-ctrls, .home-audio')) {
    el.querySelectorAll('[data-audio]').forEach((b) => b.remove());
    el.insertAdjacentHTML('beforeend', html);
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-audio]');
  if (!b) return;
  if (b.dataset.audio === 'music') {
    musicOn = !musicOn;
    store.set('fosforos.music', musicOn ? '1' : '0');
    syncMusic();
  } else {
    sfxOn = !sfxOn;
    store.set('fosforos.sfx', sfxOn ? '1' : '0');
    if (sfxOn) sfxTurn();
  }
  renderAudioButtons();
});

// ---------------- inicio ----------------
const MACHINE = 'MAQUINA';
const VOTE_MS = 20_000;
let projector = false;

const nameInput = $('#nameInput');
const codeInput = $('#codeInput');
nameInput.value = store.get('fosforos.name') || '';
const urlCode = new URLSearchParams(location.search).get('sala');
if (urlCode) codeInput.value = urlCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
const homeError = (m) => { $('#homeError').textContent = m || ''; };

function getName() {
  const n = nameInput.value.trim();
  if (!n) { homeError('Primero poné tu nombre'); nameInput.focus(); return null; }
  store.set('fosforos.name', n);
  return n;
}
function onJoined(res) {
  if (res?.error) return homeError(res.error);
  homeError('');
  session.set('fosforos.room', res.code);
  history.replaceState(null, '', `?sala=${res.code}`);
  if (res.spectator) toast('El torneo ya empezó: no se puede inscribir nadie más, pero podés mirar 👀');
}
function createRoom() {
  const name = getName();
  if (name) socket.emit('create', { name, playerId: myId, hostPlays: false }, onJoined);
}
function joinRoom() {
  const name = getName();
  if (!name) return;
  const code = codeInput.value.trim();
  if (code.length !== 4) { homeError('El código tiene 4 caracteres'); codeInput.focus(); return; }
  socket.emit('join', { code, name, playerId: myId }, onJoined);
}
$('#createBtn').addEventListener('click', createRoom);
$('#joinBtn').addEventListener('click', joinRoom);
$('#botsBtn').addEventListener('click', () => {
  const name = getName();
  if (name) socket.emit('create', { name, playerId: myId, hostPlays: true, bots: 5 }, onJoined);
});
$('#addBotBtn').addEventListener('click', () => socket.emit('addBot', 1));
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
nameInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (codeInput.value.length === 4) joinRoom(); else createRoom();
});

function leave() {
  socket.emit('leave');
  session.del('fosforos.room');
  room = null;
  focusId = null;
  projector = false;
  views.clear();
  history.replaceState(null, '', location.pathname);
  render();
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-leave]')) return;
  if (room?.state === 'playing' && P(myId)?.teamId
    && !confirm('Si salís, tu equipo sigue jugando sin vos. ¿Salir igual?')) return;
  leave();
});

// ---------------- conexión ----------------
socket.on('connect', () => {
  const code = session.get('fosforos.room');
  if (!code) return;
  socket.emit('join', { code, playerId: myId, name: store.get('fosforos.name') || '' }, (res) => {
    if (res?.error) {
      session.del('fosforos.room');
      room = null;
      render();
      toast(res.error, 'err');
    }
  });
});
socket.on('disconnect', () => { if (room) toast('Se perdió la conexión, reconectando…', 'err'); });
socket.on('state', (s) => {
  const prev = room;
  room = s;
  clockOffset = s.serverNow - Date.now();
  if (prev && prev.code === s.code) announce(prev, s);
  render();
});
socket.on('kicked', () => {
  session.del('fosforos.room');
  room = null;
  render();
  toast('Quien organiza te sacó de la sala', 'err');
});
socket.on('replaced', () => {
  session.del('fosforos.room');
  room = null;
  render();
  toast('Abriste esta sala en otra pestaña', 'err');
});

// ---------------- ayudas ----------------
const teamName = (captainId) => `Equipo de ${nameOf(captainId)}`;
const sideName = (m, side) => (side === MACHINE ? '🤖 La máquina' : teamName(m.info[side].captainId));
const inSide = (m, side, pid) => side !== MACHINE && m.info[side].members.includes(pid);
const mySide = (m) => (inSide(m, m.a, myId) ? m.a : inSide(m, m.b, myId) ? m.b : null);
const currentRound = () => room.rounds[room.currentRound];
const roundMatches = () => currentRound()?.matches ?? [];
const myMatch = () => roundMatches().find((m) => mySide(m));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function roundLabel(r, s = room) {
  return s.rounds[r]?.isFinal ? 'Final' : `Ronda ${r + 1}`;
}
function stack(ids, max, cls) {
  const ps = ids.map(P).filter(Boolean);
  const extra = ps.length - max;
  return `<span class="stack ${cls}">${ps.slice(0, max).map((p) => avatar(p, cls)).join('')}${extra > 0 ? `<span class="avatar ${cls} more">+${extra}</span>` : ''}</span>`;
}
function tallyText(tally) {
  return Object.entries(tally || {}).sort((x, y) => y[1] - x[1])
    .map(([n, c]) => `${plural(c, 'voto', 'votos')} a ${n}`).join(' · ');
}

// avisos cuando cambia algo relevante para mí
function announce(prev, s) {
  if (prev.state === 'lobby' && s.state === 'playing') toast('¡Arranca el torneo! 🔥');
  if (prev.state === 'playing' && s.state === 'playing' && s.currentRound > prev.currentRound) {
    const r = s.rounds[s.currentRound];
    toast(`${roundLabel(s.currentRound, s)}: ${r.sticks} fósforos, se saca de 1 a ${r.maxTake}`);
  }
  const before = prev.rounds[prev.currentRound]?.matches.find((m) => mySide(m));
  const after = s.rounds[s.currentRound]?.matches.find((m) => m.id === before?.id);
  if (before?.status === 'playing' && after?.status === 'done') {
    if (after.winner === mySide(after)) sfxWin(); else sfxLose();
  }
  for (const p of s.players) {
    if (!prev.players.some((x) => x.id === p.id) && p.id !== myId && !p.isBot) toast(`${p.name} se inscribió`);
  }
}

// ---------------- render ----------------
function render() {
  syncMusic();
  if (!room) {
    show('home');
    document.title = 'Fósforos · Torneo';
    return;
  }
  if (room.state === 'lobby') {
    show('lobby');
    renderLobby();
    $('#champion').classList.add('hidden');
    document.title = `Sala ${room.code} · Fósforos`;
  } else {
    show('game');
    renderGame();
    if (room.state === 'finished') showChampion(); else $('#champion').classList.add('hidden');
  }
}

// ----- sala de inscripción -----
function participants() {
  return room.players.filter((p) => p.online && (p.id !== room.hostId || room.settings.hostPlays));
}

function renderLobby() {
  const isHost = room.hostId === myId;
  const n = participants().length;
  $('#roomCode').textContent = room.code;
  $('#playerCount').textContent = n;
  $('#playerList').innerHTML = room.players.map((p) => {
    const organizer = p.id === room.hostId;
    return `
    <li class="player ${p.online ? '' : 'offline'}">
      ${avatar(p)}
      <span class="pname">${esc(p.name)}${p.id === myId ? ' <em>(vos)</em>' : ''}</span>
      ${organizer ? `<span class="tag">${room.settings.hostPlays ? '👑 organiza y juega' : '👑 organiza'}</span>` : ''}
      ${p.isBot ? '<span class="tag">bot</span>' : ''}
      ${p.online ? '' : '<span class="tag">desconectado</span>'}
      ${isHost && !organizer ? `<button class="kick" data-kick="${esc(p.id)}" title="Sacar de la sala">✕</button>` : ''}
    </li>`;
  }).join('');
  renderSettings(isHost);
  $('#addBotBtn').hidden = !isHost;
  const startBtn = $('#startBtn');
  startBtn.hidden = !isHost;
  startBtn.disabled = n < 2;
  $('#startHint').textContent = isHost
    ? (n < 2 ? 'Hacen falta al menos 2 inscriptos. ¡Compartí el código!' : `${plural(n, 'equipo', 'equipos')} de un integrante para arrancar`)
    : `Esperando que ${nameOf(room.hostId)} inicie el torneo…`;
}

function renderSettings(isHost) {
  const s = room.settings;
  $('#settings').innerHTML = `
    <ul class="rule-list">
      <li><span>🔁</span>El que pierde no queda afuera: se suma al equipo que le ganó.</li>
      <li><span>🗳️</span>Cada equipo vota su jugada: 20 segundos, gana la mayoría. Si empatan, decide MIN-MAX.</li>
      <li><span>🎲</span>Cada ronda sortea los fósforos (10 a 30) y el máximo por turno (2 a 4).</li>
      <li><span>⚖️</span>Empieza el equipo con menos integrantes; si son iguales, se sortea.</li>
      <li><span>🤖</span>Si sobra un equipo, juega contra la máquina.</li>
      <li><span>🏆</span>Ronda tras ronda hasta la final entre los dos últimos equipos.</li>
    </ul>
    <div class="setting">
      <div><b>Yo también juego</b><small>Si no, organizás y seguís todo desde la vista de proyector</small></div>
      <button class="toggle ${s.hostPlays ? 'on' : ''}" data-toggle="hostPlays" ${isHost ? '' : 'disabled'} aria-label="Yo también juego"></button>
    </div>`;
}

$('#settings').addEventListener('click', (e) => {
  const b = e.target.closest('[data-toggle]');
  if (!b || b.disabled || room?.hostId !== myId) return;
  socket.emit('settings', { [b.dataset.toggle]: !room.settings[b.dataset.toggle] });
});
$('#playerList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kick]');
  if (b) socket.emit('kick', b.dataset.kick);
});
$('#startBtn').addEventListener('click', () => socket.emit('start'));
$('#copyBtn').addEventListener('click', async () => {
  // si abriste el juego en localhost, ese link no les sirve a los demás: usamos la IP de la red local
  let origin = location.origin;
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname)) {
    try {
      const info = await (await fetch('/info')).json();
      if (info.lanOrigin) origin = info.lanOrigin;
    } catch { /* nos quedamos con el origen actual */ }
  }
  const link = `${origin}${location.pathname}?sala=${room.code}`;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = link;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`¡Link copiado! ${link}`);
});

// ----- juego -----
function pickFeatured() {
  const ms = roundMatches();
  const mine = myMatch();
  if (mine?.status === 'playing') return mine;
  return ms.find((m) => m.id === focusId) || mine || ms.find((m) => m.status === 'playing') || ms[0] || null;
}

function renderGame() {
  const isHost = room.hostId === myId;
  const round = currentRound();
  if (!isHost) projector = false;
  $('#roundTitle').textContent = room.state === 'finished' ? 'Torneo terminado' : roundLabel(room.currentRound);
  $('#roundSub').textContent = round ? `Sala ${room.code} · ${round.sticks} fósforos · se saca de 1 a ${round.maxTake}` : '';
  $('#projBtn').hidden = !isHost;
  $('#projBtn').textContent = projector ? '🎮 Vista normal' : '📽️ Proyector';
  $('#restartBtn').hidden = !isHost;
  $('#game').classList.toggle('projector', projector);

  const used = new Set();
  if (projector) {
    $('#stage').replaceChildren(...roundMatches().map((m) => matchView(m, 'proj', used)));
    $('#others').hidden = true;
    $('.game-grid').classList.add('solo');
  } else {
    const featured = pickFeatured();
    $('#stage').replaceChildren(...(featured ? [matchView(featured, 'big', used)] : []));
    const others = roundMatches().filter((m) => m !== featured);
    $('#others').hidden = others.length === 0;
    $('.game-grid').classList.toggle('solo', others.length === 0);
    $('#otherList').replaceChildren(...others.map((m) => matchView(m, 'mini', used)));
  }
  for (const k of [...views.keys()]) if (!used.has(k)) views.delete(k);

  renderBanner();
  renderTeams();
  renderHistory();

  const mine = myMatch();
  const mustVote = room.state === 'playing' && mine?.status === 'playing' && mine.vote
    && mine.turn === mySide(mine) && mine.vote.votes?.[myId] == null;
  if (mustVote && !wasMyTurn) sfxTurn();
  wasMyTurn = !!mustVote;
  document.title = mustVote ? '🗳️ ¡Votá! · Fósforos' : `${roundLabel(room.currentRound)} · Fósforos`;
}

function renderBanner() {
  const el = $('#banner');
  const me = P(myId);
  let text = '';
  let kind = '';
  if (room.state === 'finished') {
    const c = room.champion;
    text = c ? `🏆 El ${teamName(c.captainId)} ganó el torneo (${plural(c.members.length, 'integrante', 'integrantes')})` : 'El torneo terminó';
    kind = 'gold';
  } else if (!me?.teamId) {
    text = room.hostId === myId
      ? (projector ? '📽️ Vista de proyector: todas las partidas de la ronda y quién está en posición ganadora según MIN-MAX'
        : '📽️ Organizás el torneo: abrí la vista de proyector para ver todas las partidas')
      : '👀 Estás mirando: el torneo ya había empezado cuando entraste';
  } else {
    const m = myMatch();
    const my = m && mySide(m);
    if (m?.status === 'playing') {
      if (m.reveal) {
        text = m.turn === my ? `🗳️ Tu equipo juega ${m.reveal.n}` : `${sideName(m, m.turn)} juega ${m.reveal.n}`;
      } else if (m.turn === my) {
        const voted = m.vote?.votes?.[myId];
        const total = m.vote?.total ?? 0;
        if (voted != null) text = total > 1 ? `✅ Votaste ${voted} · esperando al resto (${m.vote.voters.length}/${total})` : `✅ Elegiste ${voted}`;
        else { text = total > 1 ? '🗳️ ¡Votá cuántos fósforos sacar!' : '🔥 ¡Es tu turno!'; kind = 'hot'; }
      } else {
        text = m.turn === MACHINE ? '🤖 La máquina está pensando…' : `⏳ Vota el ${sideName(m, m.turn)}`;
      }
    } else if (m?.status === 'done') {
      if (m.winner === my) { text = '🎉 ¡Ganó tu equipo! Esperando que terminen las otras partidas…'; kind = 'win'; } else {
        const t = room.teams.find((x) => x.id === me.teamId);
        text = t && t.id !== my ? `🔁 Perdieron, pero siguen en carrera: ahora juegan en el ${teamName(t.captainId)}` : '🔁 Perdieron contra la máquina: al cerrar la ronda se suman a otro equipo';
        kind = 'out';
      }
    }
  }
  if (room.nextRoundAt && room.state === 'playing') {
    const secs = Math.max(0, Math.ceil((room.nextRoundAt - now()) / 1000));
    text = `${text ? `${text} · ` : ''}Próxima ronda en ${secs}s`;
  }
  el.textContent = text;
  el.className = `banner ${kind}`;
  el.hidden = !text;
}

// Vista de una partida ('big', 'proj' o 'mini'). Se reutiliza el DOM para animar los fósforos que se queman.
function matchView(m, mode, used) {
  const key = `${m.id}:${mode}`;
  used.add(key);
  let v = views.get(key);
  if (!v) {
    const el = document.createElement('div');
    el.className = `match ${mode === 'mini' ? 'mini' : 'big'} ${mode === 'proj' ? 'proj' : ''}`;
    el.innerHTML = mode === 'mini'
      ? '<div class="mini-head"></div><div class="sticks"></div><div class="mini-done"></div>'
      : `<div class="mv-head"></div><div class="mv-timer"><i></i></div>
         <div class="mv-table"><div class="sticks"></div></div>
         <div class="mv-foot"></div><div class="mv-result"></div>`;
    v = { el, mode, count: null, m };
    views.set(key, v);
    if (mode === 'mini') el.addEventListener('click', () => { focusId = v.m.id; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    if (mode === 'big') bindPlay(v);
  }
  const changed = v.count !== null && v.count !== m.sticks;
  v.m = m;
  updateSticks(v, m);
  if (mode === 'mini') updateMini(v, m); else updateBig(v, m, changed);
  return v.el;
}

function updateSticks(v, m) {
  const box = $('.sticks', v.el);
  const shown = m.sticks;
  if (v.count === null || shown > v.count) {
    box.dataset.size = m.initial > 22 ? 's' : m.initial > 15 ? 'm' : 'l';
    box.innerHTML = Array.from({ length: shown }, (_, i) => `<i class="stick" data-i="${i}" style="--d:${v.count === null ? i * 20 : 0}ms"></i>`).join('');
  } else if (shown < v.count) {
    const alive = [...box.querySelectorAll('.stick:not(.gone)')];
    alive.slice(shown).forEach((s, k) => {
      s.classList.remove('sel', 'pick');
      s.style.animationDelay = `${k * 90}ms`;
      s.classList.add('gone');
      s.addEventListener('animationend', (e) => { if (e.target === s && e.animationName === 'burn') s.remove(); });
    });
    if (v.mode === 'big') sfxStrike();
  }
  v.count = shown;
  // F-20: mientras se muestra la jugada votada, se marcan los fósforos que se van a sacar
  const alive = [...box.querySelectorAll('.stick:not(.gone)')];
  const n = m.reveal?.n ?? 0;
  alive.forEach((s, i) => s.classList.toggle('pick', n > 0 && i >= alive.length - n));
}

function sideHtml(m, side, right) {
  const machine = side === MACHINE;
  const info = m.info[side];
  const mine = mySide(m) === side;
  const cls = [right ? 'right' : '', m.status === 'playing' && m.turn === side ? 'turn' : '',
    m.winner === side ? 'win' : '', m.loser === side ? 'lose' : '', mine ? 'mine' : ''].join(' ');
  const pic = machine ? '<span class="avatar lg machine">🤖</span>' : stack(info.members, 4, 'md');
  const sub = machine ? 'juega con MIN-MAX' : `${plural(info.members.length, 'integrante', 'integrantes')}${mine ? ' · tu equipo' : ''}`;
  return `<div class="side ${cls}" style="--team:${info.color}">${pic}<div><b>${esc(sideName(m, side))}</b><small>${sub}</small></div></div>`;
}

function revealHtml(m) {
  const r = m.reveal;
  const sub = r.how === 'tiebreak' ? `Empate (${tallyText(r.tally)}): decidió la máquina con MIN-MAX`
    : r.how === 'none' ? 'Nadie votó a tiempo: se saca 1'
      : tallyText(r.tally);
  return `<div class="reveal"><div class="rv-n">Se juega <b>${r.n}</b></div><div class="rv-sub">${esc(sub)}</div></div>`;
}

function lastMoveHtml(m) {
  const lm = m.lastMove;
  if (!lm) return '<div class="last-move">Nadie sacó todavía</div>';
  const extra = lm.how === 'tiebreak' ? ' (desempate MIN-MAX)' : lm.how === 'none' ? ' (nadie votó)' : '';
  return `<div class="last-move"><b>${esc(sideName(m, lm.by))}</b> sacó ${lm.took}${extra}</div>`;
}

function resultText(m) {
  const winner = sideName(m, m.winner);
  const loser = sideName(m, m.loser);
  if (m.loser === MACHINE) return `${winner} le ganó a la máquina y sigue igual`;
  if (m.winner === MACHINE) {
    return m.absorbed
      ? `La máquina le ganó: se sumaron al ${teamName(m.absorbed.intoCaptainId)}`
      : 'La máquina le ganó: al cerrar la ronda se suman a un equipo al azar';
  }
  return `${loser} se suma al ${winner} (+${m.absorbed?.count ?? 0})`;
}

function updateBig(v, m, changed) {
  const proj = v.mode === 'proj';
  const my = mySide(m);
  const canVote = !proj && m.status === 'playing' && m.vote && m.turn === my;
  v.el.classList.toggle('playable', !!canVote);

  $('.mv-head', v.el).innerHTML = `
    ${sideHtml(m, m.a, false)}
    <div class="center-count"><div class="count ${changed ? 'bump' : ''}">${m.sticks}</div><small>de 1 a ${m.maxTake}</small></div>
    ${sideHtml(m, m.b, true)}`;

  const timer = $('.mv-timer', v.el);
  timer.classList.toggle('on', !!m.vote);
  timer.dataset.deadline = m.vote?.deadline || '';

  let foot = '';
  if (m.status === 'playing') {
    if (m.reveal) {
      foot = revealHtml(m);
    } else if (canVote) {
      const votes = m.vote.votes || {};
      const mine = votes[myId];
      const opts = Array.from({ length: Math.min(m.maxTake, m.sticks) }, (_, i) => i + 1);
      const votersFor = (n) => Object.keys(votes).filter((pid) => votes[pid] === n);
      foot = `<div class="vote-row">${opts.map((n) => `
        <button class="vote-btn ${mine === n ? 'on' : ''}" data-vote="${n}">
          <span class="vn">${n}</span><span class="vl">${n === 1 ? 'fósforo' : 'fósforos'}</span>
          <span class="vv">${stack(votersFor(n), 5, 'xs')}</span>
        </button>`).join('')}</div>
        <div class="hint">${m.vote.total > 1
    ? `Votaron ${m.vote.voters.length} de ${m.vote.total}. Podés cambiar tu voto hasta que cierre.`
    : 'Tocá un botón, los fósforos o las teclas del 1 al ' + opts.length}</div>`;
    } else if (m.turn === MACHINE) {
      foot = '<div class="waiting">🤖 La máquina está pensando<span class="dots"></span></div>';
    } else {
      foot = `<div class="waiting">Vota el <b>${esc(sideName(m, m.turn))}</b><span class="dots"></span>
        <small>(${m.vote?.voters.length ?? 0}/${m.vote?.total ?? 0})</small></div>`;
    }
    if (proj && m.winningSide) {
      // F-14: qué equipo está en posición ganadora según MIN-MAX
      foot += `<div class="minmax" style="--team:${m.info[m.winningSide].color}">🧠 MIN-MAX: posición ganadora para <b>${esc(sideName(m, m.winningSide))}</b></div>`;
    }
    if (!m.reveal) foot += lastMoveHtml(m);
  }
  $('.mv-foot', v.el).innerHTML = foot;

  const res = $('.mv-result', v.el);
  if (m.status === 'done') {
    const won = my && m.winner === my;
    const lost = my && m.loser === my;
    res.className = `mv-result on ${won ? 'won' : lost ? 'lost' : ''}`;
    const key = `${m.id}:${m.absorbed ? 1 : 0}`;
    if (res.dataset.for !== key) {
      res.dataset.for = key;
      res.innerHTML = `<div>
        <div class="big-emoji">${won ? '🏆' : lost ? '🔁' : '🎯'}</div>
        <h3>${won ? '¡Ganó tu equipo!' : lost ? 'Perdió tu equipo' : `Gana ${esc(sideName(m, m.winner))}`}</h3>
        <p>${esc(resultText(m))}</p>
        ${lost ? '<p>No quedás afuera: seguís jugando con tu nuevo equipo 💪</p>' : ''}
      </div>`;
    }
  } else {
    res.className = 'mv-result';
    res.dataset.for = '';
  }
}

function updateMini(v, m) {
  const cls = (side) => [m.status === 'playing' && m.turn === side ? 'turn' : '', m.winner === side ? 'win' : '', m.loser === side ? 'lose' : ''].join(' ');
  const dot = (side) => `<span class="dot" style="--c:${m.info[side].color}"></span>`;
  $('.mini-head', v.el).innerHTML = `
    ${dot(m.a)}<span class="nm ${cls(m.a)}">${esc(sideName(m, m.a))}</span>
    <span class="vs">${m.status === 'playing' ? m.sticks : 'vs'}</span>
    <span class="nm r ${cls(m.b)}">${esc(sideName(m, m.b))}</span>${dot(m.b)}`;
  $('.mini-done', v.el).textContent = m.status === 'done' ? `🏆 ${resultText(m)}`
    : m.reveal ? `${sideName(m, m.turn)} juega ${m.reveal.n}` : '';
}

// pasar el mouse marca, click vota
function bindPlay(v) {
  let pointer = 'mouse';
  const canVote = () => v.m.status === 'playing' && v.m.vote && v.m.turn === mySide(v.m);
  const voteFor = (i) => {
    if (!canVote()) return 0;
    const n = v.m.sticks - i;
    return n >= 1 && n <= v.m.maxTake ? n : 0;
  };
  const highlight = (n) => {
    const alive = [...v.el.querySelectorAll('.stick:not(.gone)')];
    alive.forEach((s, idx) => s.classList.toggle('sel', n > 0 && idx >= alive.length - n));
  };
  const amountAt = (target) => {
    const st = target.closest('.stick:not(.gone)');
    if (st) return { n: voteFor(Number(st.dataset.i)), st };
    const b = target.closest('[data-vote]');
    return { n: b && canVote() ? Number(b.dataset.vote) : 0, st: null };
  };
  v.el.addEventListener('pointerdown', (e) => { pointer = e.pointerType; });
  v.el.addEventListener('mouseover', (e) => { if (pointer === 'mouse') highlight(amountAt(e.target).n); });
  v.el.addEventListener('mouseleave', () => highlight(0));
  v.el.addEventListener('click', (e) => {
    const { n, st } = amountAt(e.target);
    if (!n) return;
    // en pantallas táctiles el primer toque sobre un fósforo marca y el segundo confirma
    if (st && pointer !== 'mouse' && !st.classList.contains('sel')) { highlight(n); return; }
    highlight(0);
    socket.emit('vote', n);
  });
}

document.addEventListener('keydown', (e) => {
  if (!room || room.state !== 'playing' || e.target.matches('input')) return;
  const n = Number(e.key);
  const m = myMatch();
  if (m?.status === 'playing' && m.vote && m.turn === mySide(m) && n >= 1 && n <= Math.min(m.maxTake, m.sticks)) {
    socket.emit('vote', n);
  }
});

$('#projBtn').addEventListener('click', () => {
  projector = !projector;
  render();
});

// ----- equipos e historial -----
function renderTeams() {
  const teams = [...room.teams].sort((x, y) => y.members.length - x.members.length);
  const total = teams.reduce((n, t) => n + t.members.length, 0) || 1;
  const mine = P(myId)?.teamId;
  $('#teamCount').textContent = teams.length;
  $('#teams').innerHTML = teams.map((t) => `
    <div class="team ${t.id === mine ? 'mine' : ''}">
      <div class="team-top">
        <span class="dot" style="--c:${t.color}"></span>
        <b>${esc(teamName(t.captainId))}</b>
        ${t.id === mine ? '<span class="tag">tu equipo</span>' : ''}
        <span class="cnt">${t.members.length}</span>
      </div>
      <div class="bar"><i style="width:${(t.members.length / total) * 100}%;background:${t.color}"></i></div>
      <div class="team-members">${stack(t.members, 14, 'xs')}</div>
    </div>`).join('');
}

function renderHistory() {
  $('#history').innerHTML = room.rounds.map((round, i) => `
    <div class="h-round">
      <div class="h-title">${roundLabel(i)} · ${round.sticks} fósforos, de 1 a ${round.maxTake}</div>
      ${round.matches.map((m) => (m.status === 'done'
    ? `<div class="h-line">🏆 <b>${esc(sideName(m, m.winner))}</b> le ganó ${m.loser === MACHINE ? 'a la máquina' : `al ${esc(sideName(m, m.loser))}`}
            <small>${esc(resultText(m))}</small></div>`
    : `<div class="h-line live">● ${esc(sideName(m, m.a))} vs ${esc(sideName(m, m.b))} <small>quedan ${m.sticks}</small></div>`)).join('')}
    </div>`).reverse().join('');
}

$('#restartBtn').addEventListener('click', () => {
  if (room.state === 'finished' || confirm('¿Cortar el torneo y volver a la inscripción?')) socket.emit('restart');
});

// ----- campeón -----
function showChampion() {
  const key = `${room.code}:${room.tournamentNo}`;
  const c = room.champion;
  const isMine = c?.members.includes(myId);
  $('#champMembers').innerHTML = c ? c.members.map((id) => {
    const p = P(id);
    return p ? `<div class="cm">${avatar(p, 'md')}<span>${esc(p.name)}</span></div>` : '';
  }).join('') : '';
  $('#champName').textContent = c ? (isMine ? '¡Tu equipo es campeón!' : teamName(c.captainId)) : 'Torneo terminado';
  $('#champSub').textContent = c ? `${teamName(c.captainId)} · ${plural(c.members.length, 'integrante', 'integrantes')}` : '';
  const isHost = room.hostId === myId;
  $('#againBtn').hidden = !isHost;
  $('#champHint').textContent = isHost ? '' : `${nameOf(room.hostId)} puede arrancar otro torneo`;
  if (championDismissed !== key) $('#champion').classList.remove('hidden');
  if (championShown !== key) {
    championShown = key;
    sfxFanfare();
    confetti();
  }
}
$('#againBtn').addEventListener('click', () => socket.emit('restart'));
$('#viewBracketBtn').addEventListener('click', () => {
  championDismissed = `${room.code}:${room.tournamentNo}`;
  $('#champion').classList.add('hidden');
});

function confetti() {
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#ff7a2f', '#ffd166', '#4cc58a', '#4dabf7', '#f783ac', '#fff'];
  const parts = Array.from({ length: 220 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 4,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const end = performance.now() + 4500;
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (t < end) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  }(performance.now()));
}

// ----- relojes -----
setInterval(() => {
  if (!room || room.state !== 'playing') return;
  for (const t of document.querySelectorAll('.mv-timer.on')) {
    const left = Number(t.dataset.deadline) - now();
    t.firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, left / VOTE_MS))})`;
    t.classList.toggle('low', left < 5000);
  }
  if (room.nextRoundAt) renderBanner();
}, 100);

// brasas decorativas
(function embers() {
  const box = $('.embers');
  for (let i = 0; i < 18; i++) {
    const e = document.createElement('i');
    e.style.left = `${Math.random() * 100}%`;
    e.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    e.style.animationDuration = `${9 + Math.random() * 12}s`;
    e.style.animationDelay = `${-Math.random() * 20}s`;
    e.style.transform = `scale(${0.4 + Math.random() * 0.8})`;
    box.append(e);
  }
}());

renderAudioButtons();
render();
