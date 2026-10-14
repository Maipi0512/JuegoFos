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
  ? `<span class="avatar ${cls}" style="--c:${p.color}">${esc(p.name[0].toUpperCase())}</span>`
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
}
function createRoom() {
  const name = getName();
  if (name) socket.emit('create', { name, playerId: myId }, onJoined);
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
  views.clear();
  history.replaceState(null, '', location.pathname);
  render();
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-leave]')) return;
  const me = P(myId);
  if (room?.state === 'playing' && me && !me.eliminated && !me.spectator
    && !confirm('Si salís ahora quedás eliminado del torneo. ¿Salir igual?')) return;
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
      if (res.error) toast(res.error, 'err');
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
  toast('El anfitrión te sacó de la sala', 'err');
});
socket.on('replaced', () => {
  session.del('fosforos.room');
  room = null;
  render();
  toast('Abriste esta sala en otra pestaña', 'err');
});

// avisos cuando cambia algo relevante para mí
function announce(prev, s) {
  if (prev.state === 'lobby' && s.state === 'playing') toast('¡Arranca el torneo! 🔥');
  if (prev.state === 'playing' && s.state === 'playing' && s.currentRound > prev.currentRound) {
    toast(`Empieza ${roundName(s.currentRound, s)}`);
  }
  const before = prev.rounds[prev.currentRound]?.find((m) => m.p1 === myId || m.p2 === myId);
  const after = s.rounds[s.currentRound]?.find((m) => m.id === before?.id);
  if (before?.status === 'playing' && after?.status === 'done') {
    if (after.winner === myId) sfxWin(); else sfxLose();
  }
  for (const p of s.players) {
    const old = prev.players.find((x) => x.id === p.id);
    if (!old && p.id !== myId) toast(`${p.name} entró a la sala`);
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

function roundsFor(n) { let t = 0; while (n > 1) { n = Math.ceil(n / 2); t++; } return t; }
function roundName(r, s = room) {
  const left = s.totalRounds - r;
  if (left === 1) return 'la Final';
  if (left === 2) return 'la Semifinal';
  if (left === 3) return 'los Cuartos de final';
  return `la Ronda ${r + 1}`;
}
const roundLabel = (r) => {
  const n = roundName(r).replace(/^(la|los) /, '');
  return n.charAt(0).toUpperCase() + n.slice(1);
};

// ----- lobby -----
function renderLobby() {
  const isHost = room.hostId === myId;
  $('#roomCode').textContent = room.code;
  $('#playerCount').textContent = room.players.length;
  $('#playerList').innerHTML = room.players.map((p) => `
    <li class="player ${p.online ? '' : 'offline'}">
      ${avatar(p)}
      <span class="pname">${esc(p.name)}${p.id === myId ? ' <em>(vos)</em>' : ''}</span>
      ${p.id === room.hostId ? '<span title="Anfitrión">👑</span>' : ''}
      ${p.online ? '' : '<span class="tag">desconectado</span>'}
      ${isHost && p.id !== myId ? `<button class="kick" data-kick="${esc(p.id)}" title="Sacar de la sala">✕</button>` : ''}
    </li>`).join('');
  renderSettings(isHost);
  const online = room.players.filter((p) => p.online).length;
  const startBtn = $('#startBtn');
  startBtn.hidden = !isHost;
  startBtn.disabled = online < 2;
  $('#startHint').textContent = isHost
    ? (online < 2 ? 'Necesitás al menos 2 jugadores. ¡Compartí el código!' : `${online} jugadores · ${roundsFor(online)} ${roundsFor(online) === 1 ? 'ronda' : 'rondas'}`)
    : `Esperando que ${nameOf(room.hostId)} empiece el torneo…`;
}

function renderSettings(isHost) {
  const s = room.settings;
  const dis = isHost ? '' : 'disabled';
  const seg = (key, opts) => `<div class="seg">${opts.map(([v, label]) => `
    <button class="${s[key] === v ? 'on' : ''}" data-set="${key}" data-val="${v}" ${dis}>${label}</button>`).join('')}</div>`;
  $('#settings').innerHTML = `
    <div class="setting">
      <div><b>Fósforos por partida</b><small>${s.randomSticks ? 'Cada partida arranca con 10 a 25' : 'Cantidad inicial en la mesa'}</small></div>
      <div class="stepper">
        <button data-set="sticks" data-delta="-1" ${isHost && !s.randomSticks && s.sticks > 5 ? '' : 'disabled'}>−</button>
        <span>${s.randomSticks ? '🎲' : s.sticks}</span>
        <button data-set="sticks" data-delta="1" ${isHost && !s.randomSticks && s.sticks < 40 ? '' : 'disabled'}>+</button>
      </div>
    </div>
    <div class="setting">
      <div><b>Cantidad sorpresa</b><small>Cada partida con un número al azar</small></div>
      <button class="toggle ${s.randomSticks ? 'on' : ''}" data-toggle="randomSticks" ${dis} aria-label="Cantidad sorpresa"></button>
    </div>
    <div class="setting">
      <div><b>Máximo por turno</b><small>Se puede sacar de 1 a…</small></div>
      ${seg('maxTake', [[2, '2'], [3, '3'], [4, '4']])}
    </div>
    <div class="setting">
      <div><b>Tiempo por turno</b><small>Si se acaba, se saca 1 solo</small></div>
      ${seg('turnSeconds', [[0, '∞'], [10, '10s'], [20, '20s'], [30, '30s']])}
    </div>`;
}

$('#settings').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled || room?.hostId !== myId) return;
  const s = { ...room.settings };
  if (b.dataset.toggle) s[b.dataset.toggle] = !s[b.dataset.toggle];
  else if (b.dataset.delta) s[b.dataset.set] += Number(b.dataset.delta);
  else if (b.dataset.val != null) s[b.dataset.set] = Number(b.dataset.val);
  socket.emit('settings', s);
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
const currentRound = () => room.rounds[room.currentRound] || [];
const myMatchIn = (round) => round.find((m) => m.p1 === myId || m.p2 === myId);

function pickFeatured() {
  const round = currentRound();
  const playable = round.filter((m) => m.status !== 'bye');
  const mine = myMatchIn(round);
  if (mine?.status === 'playing') return mine;
  return playable.find((m) => m.id === focusId)
    || (mine?.status === 'done' ? mine : null)
    || playable.find((m) => m.status === 'playing')
    || playable[0]
    || null;
}

function renderGame() {
  const isHost = room.hostId === myId;
  $('#roundTitle').textContent = room.state === 'finished' ? 'Torneo terminado' : roundLabel(room.currentRound);
  $('#roundSub').textContent = `Sala ${room.code} · Ronda ${room.currentRound + 1} de ${room.totalRounds}`;
  $('#restartBtn').hidden = !isHost;

  const featured = pickFeatured();
  const used = new Set();
  $('#stage').replaceChildren(...(featured ? [matchView(featured, false, used)] : []));
  const others = currentRound().filter((m) => m.status !== 'bye' && m !== featured);
  $('#others').hidden = others.length === 0;
  $('.game-grid').classList.toggle('solo', others.length === 0);
  $('#otherList').replaceChildren(...others.map((m) => matchView(m, true, used)));
  for (const k of [...views.keys()]) if (!used.has(k)) views.delete(k);

  renderBanner();
  renderBracket(featured);

  const mine = myMatchIn(currentRound());
  const myTurn = room.state === 'playing' && mine?.status === 'playing' && mine.turn === myId;
  if (myTurn && !wasMyTurn) sfxTurn();
  wasMyTurn = myTurn;
  document.title = myTurn ? '🔥 ¡Tu turno! · Fósforos' : `${roundLabel(room.currentRound)} · Fósforos`;
}

function renderBanner() {
  const el = $('#banner');
  const me = P(myId);
  const mine = myMatchIn(currentRound());
  let text = '';
  let kind = '';
  if (room.state === 'finished') {
    text = room.championId ? `🏆 ${nameOf(room.championId)} ganó el torneo` : 'El torneo terminó';
    kind = 'gold';
  } else if (!me || me.spectator) {
    text = '👀 Estás mirando: entraste con el torneo ya empezado';
  } else if (me.eliminated) {
    text = '💀 Quedaste afuera del torneo. Podés seguir mirando las partidas.';
    kind = 'out';
  } else if (mine?.status === 'bye') {
    text = '✨ Te tocó pase libre: avanzás directo a la próxima ronda';
    kind = 'win';
  } else if (mine?.status === 'playing') {
    if (mine.turn === myId) { text = '🔥 ¡Es tu turno!'; kind = 'hot'; } else text = `⏳ Le toca a ${nameOf(mine.turn)}`;
  } else if (mine?.status === 'done') {
    text = '🎉 ¡Ganaste la partida! Esperando que terminen las demás…';
    kind = 'win';
  }
  if (room.nextRoundAt && room.state === 'playing') {
    const secs = Math.max(0, Math.ceil((room.nextRoundAt - now()) / 1000));
    text = `${text ? `${text} · ` : ''}Próxima ronda en ${secs}s`;
  }
  el.textContent = text;
  el.className = `banner ${kind}`;
  el.hidden = !text;
}

// Vista de una partida. Se reutiliza el DOM entre actualizaciones para poder animar los fósforos que se queman.
function matchView(m, mini, used) {
  const key = `${m.id}:${mini ? 'mini' : 'big'}`;
  used.add(key);
  let v = views.get(key);
  if (!v) {
    const el = document.createElement('div');
    el.className = `match ${mini ? 'mini' : 'big'}`;
    el.innerHTML = mini
      ? '<div class="mini-head"></div><div class="sticks"></div><div class="mini-done"></div>'
      : `<div class="mv-head"></div><div class="mv-timer"><i></i></div>
         <div class="mv-table"><div class="sticks"></div></div>
         <div class="mv-foot"></div><div class="mv-result"></div>`;
    v = { el, mini, count: null, m };
    views.set(key, v);
    if (mini) el.addEventListener('click', () => { focusId = v.m.id; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    else bindPlay(v);
  }
  const changed = v.count !== null && v.count !== m.sticks;
  v.m = m;
  updateSticks(v, m);
  if (mini) updateMini(v, m); else updateBig(v, m, changed);
  return v.el;
}

function updateSticks(v, m) {
  const box = $('.sticks', v.el);
  const shown = m.status === 'done' && m.sticks === 0 ? 0 : m.sticks;
  if (v.count === null || shown > v.count) {
    box.dataset.size = m.initial > 30 ? 's' : m.initial > 18 ? 'm' : 'l';
    box.innerHTML = Array.from({ length: shown }, (_, i) => `<i class="stick" data-i="${i}" style="--d:${v.count === null ? i * 25 : 0}ms"></i>`).join('');
  } else if (shown < v.count) {
    const alive = [...box.querySelectorAll('.stick:not(.gone)')];
    alive.slice(shown).forEach((s, k) => {
      s.classList.remove('sel');
      s.style.animationDelay = `${k * 90}ms`;
      s.classList.add('gone');
      s.addEventListener('animationend', (e) => { if (e.target === s && e.animationName === 'burn') s.remove(); });
    });
    if (!v.mini) sfxStrike();
  }
  v.count = shown;
}

function sideHtml(m, pid, right) {
  const p = P(pid);
  const cls = [right ? 'right' : '', m.turn === pid ? 'turn' : '', m.winner === pid ? 'win' : '', m.loser === pid ? 'lose' : ''].join(' ');
  const sub = pid === myId ? 'vos' : (p && !p.online ? 'desconectado' : (m.turn === pid ? 'pensando…' : ''));
  return `<div class="side ${cls}">${avatar(p, 'lg')}<div><b>${esc(p?.name ?? '—')}</b><small>${sub}</small></div></div>`;
}

function reasonText(m) {
  const loser = nameOf(m.loser);
  if (m.reason === 'last') return `${loser} se quedó con el último fósforo`;
  if (m.reason === 'disconnect') return `${loser} se desconectó`;
  if (m.reason === 'left') return `${loser} abandonó el torneo`;
  return '';
}

function updateBig(v, m, changed) {
  const max = room.settings.maxTake;
  const iPlay = m.p1 === myId || m.p2 === myId;
  const myTurn = m.status === 'playing' && m.turn === myId;
  v.el.classList.toggle('playable', myTurn);

  $('.mv-head', v.el).innerHTML = `
    ${sideHtml(m, m.p1, false)}
    <div class="center-count"><div class="count ${changed ? 'bump' : ''}">${m.sticks}</div><small>${m.sticks === 1 ? 'fósforo' : 'fósforos'}</small></div>
    ${sideHtml(m, m.p2, true)}`;

  const timer = $('.mv-timer', v.el);
  timer.classList.toggle('on', !!m.turnDeadline);
  timer.dataset.deadline = m.turnDeadline || '';

  const last = m.lastMove
    ? `<div class="last-move"><b>${esc(m.lastMove.by === myId ? 'Vos' : nameOf(m.lastMove.by))}</b> ${m.lastMove.by === myId ? 'sacaste' : 'sacó'} ${m.lastMove.took}${m.lastMove.auto ? ' (se le acabó el tiempo ⌛)' : ''}</div>`
    : '<div class="last-move">Nadie sacó todavía</div>';
  let foot = '';
  if (m.status === 'playing' && myTurn) {
    const opts = Array.from({ length: Math.min(max, m.sticks) }, (_, i) => i + 1);
    foot = `<div class="take-row">${opts.map((n) => `<button class="btn primary" data-take="${n}">Sacar ${n}</button>`).join('')}</div>
            <div class="hint">También podés tocar los fósforos o usar las teclas ${opts.join(', ')}</div>`;
  } else if (m.status === 'playing') {
    foot = `<div class="waiting">${iPlay ? 'Esperando a' : 'Le toca a'} <b>${esc(nameOf(m.turn))}</b><span class="dots"></span></div>`;
  }
  $('.mv-foot', v.el).innerHTML = foot + (m.status === 'playing' ? last : '');

  const res = $('.mv-result', v.el);
  if (m.status === 'done') {
    const won = m.winner === myId;
    const lost = m.loser === myId;
    res.className = `mv-result on ${won ? 'won' : lost ? 'lost' : ''}`;
    if (res.dataset.for !== m.id) {
      res.dataset.for = m.id;
      res.innerHTML = `<div>
        <div class="big-emoji">${won ? '🏆' : lost ? '🔥' : '🎯'}</div>
        <h3>${won ? '¡Ganaste!' : lost ? 'Perdiste' : `Gana ${esc(nameOf(m.winner))}`}</h3>
        <p>${esc(reasonText(m))}</p>
        ${lost ? '<p>Quedás afuera del torneo, pero podés seguir mirando 👀</p>' : ''}
        ${won && room.state === 'playing' ? '<p>¡Pasás a la siguiente ronda!</p>' : ''}
      </div>`;
    }
  } else {
    res.className = 'mv-result';
    res.dataset.for = '';
  }
}

function updateMini(v, m) {
  const cls = (pid) => [m.turn === pid ? 'turn' : '', m.winner === pid ? 'win' : '', m.loser === pid ? 'lose' : ''].join(' ');
  $('.mini-head', v.el).innerHTML = `
    ${avatar(P(m.p1), 'sm')}<span class="nm ${cls(m.p1)}">${esc(nameOf(m.p1))}</span>
    <span class="vs">${m.status === 'playing' ? m.sticks : 'vs'}</span>
    <span class="nm r ${cls(m.p2)}">${esc(nameOf(m.p2))}</span>${avatar(P(m.p2), 'sm')}`;
  $('.mini-done', v.el).textContent = m.status === 'done' ? `🏆 ${nameOf(m.winner)} — ${reasonText(m)}` : '';
}

// interacción con los fósforos: pasar el mouse selecciona, click saca
function bindPlay(v) {
  let pointer = 'mouse';
  const canPlay = () => v.m.status === 'playing' && v.m.turn === myId;
  const takeFor = (i) => {
    if (!canPlay()) return 0;
    const n = v.m.sticks - i;
    return n >= 1 && n <= room.settings.maxTake ? n : 0;
  };
  const highlight = (n) => {
    const alive = [...v.el.querySelectorAll('.stick:not(.gone)')];
    alive.forEach((s, idx) => s.classList.toggle('sel', n > 0 && idx >= alive.length - n));
  };
  const amountAt = (target) => {
    const st = target.closest('.stick:not(.gone)');
    if (st) return { n: takeFor(Number(st.dataset.i)), st };
    const b = target.closest('[data-take]');
    return { n: b && canPlay() ? Number(b.dataset.take) : 0, st: null };
  };
  v.el.addEventListener('pointerdown', (e) => { pointer = e.pointerType; });
  v.el.addEventListener('mouseover', (e) => { if (pointer === 'mouse') highlight(amountAt(e.target).n); });
  v.el.addEventListener('mouseleave', () => highlight(0));
  v.el.addEventListener('click', (e) => {
    const { n, st } = amountAt(e.target);
    if (!n) return;
    // en pantallas táctiles el primer toque marca y el segundo confirma
    if (st && pointer !== 'mouse' && !st.classList.contains('sel')) { highlight(n); return; }
    socket.emit('take', n);
  });
}

document.addEventListener('keydown', (e) => {
  if (!room || room.state !== 'playing' || e.target.matches('input')) return;
  const n = Number(e.key);
  const mine = myMatchIn(currentRound());
  if (mine?.status === 'playing' && mine.turn === myId && n >= 1 && n <= room.settings.maxTake && n <= mine.sticks) {
    socket.emit('take', n);
  }
});

// ----- llave -----
function renderBracket(featured) {
  const r0 = room.rounds[0] || [];
  let alive = r0.reduce((n, m) => n + (m.p2 ? 2 : 1), 0);
  const row = (m, pid) => {
    if (!pid) return '<div class="b-row bye"><span class="avatar ghost sm">–</span><span class="nm">pase libre</span></div>';
    const cls = [m.winner === pid && m.status !== 'playing' ? 'win' : '', m.loser === pid ? 'lose' : '', pid === myId ? 'me' : ''].join(' ');
    const badge = m.status === 'playing' && m.turn === pid ? '<span class="badge">●</span>' : (m.winner === pid && m.status === 'done' ? '<span class="badge">✓</span>' : '');
    return `<div class="b-row ${cls}">${avatar(P(pid), 'sm')}<span class="nm">${esc(nameOf(pid))}</span>${badge}</div>`;
  };
  const placeholder = '<div class="b-match pending"><div class="b-row"><span class="avatar ghost sm">?</span><span class="nm">—</span></div><div class="b-row"><span class="avatar ghost sm">?</span><span class="nm">—</span></div></div>';
  const cols = [];
  for (let r = 0; r < room.totalRounds; r++) {
    const count = Math.ceil(alive / 2);
    alive = count;
    const ms = room.rounds[r];
    const body = ms
      ? ms.map((m) => {
        const clickable = r === room.currentRound && m.status !== 'bye';
        return `<div class="b-match ${m.status} ${clickable ? 'clickable' : ''} ${featured?.id === m.id ? 'focus' : ''}" ${clickable ? `data-mid="${m.id}"` : ''}>
          ${row(m, m.p1)}${row(m, m.p2)}</div>`;
      }).join('')
      : placeholder.repeat(count);
    cols.push(`<div class="b-col"><div class="b-title">${roundLabel(r)}</div><div class="b-list">${body}</div></div>`);
  }
  const champ = P(room.championId);
  cols.push(`<div class="b-col"><div class="b-title">Campeón</div><div class="b-list">
    <div class="b-champ">${champ ? `${avatar(champ, 'lg')}<span>${esc(champ.name)}</span>` : '<span class="cup">🏆</span><span class="muted">¿Quién será?</span>'}</div>
  </div></div>`);
  $('#bracket').innerHTML = cols.join('');
}
$('#bracket').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mid]');
  if (!b) return;
  focusId = b.dataset.mid;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('#restartBtn').addEventListener('click', () => {
  if (room.state === 'finished' || confirm('¿Cortar el torneo y volver a la sala de espera?')) socket.emit('restart');
});

// ----- campeón -----
function showChampion() {
  const key = `${room.code}:${room.tournamentNo}`;
  const champ = P(room.championId);
  const isMe = room.championId === myId;
  $('#champAvatar').innerHTML = champ ? avatar(champ, 'xl') : '';
  $('#champName').textContent = champ ? (isMe ? '¡Ganaste el torneo!' : champ.name) : 'Torneo terminado';
  $('#champSub').textContent = champ ? (isMe ? 'Nadie te pudo dejar con el último fósforo 🔥' : 'es quien ganó el torneo 🔥') : 'No quedó nadie en pie';
  const isHost = room.hostId === myId;
  $('#againBtn').hidden = !isHost;
  $('#champHint').textContent = isHost ? '' : `${nameOf(room.hostId)} puede arrancar otra ronda`;
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
  const total = room.settings.turnSeconds * 1000;
  for (const t of document.querySelectorAll('.mv-timer.on')) {
    const left = Number(t.dataset.deadline) - now();
    const frac = total ? Math.max(0, Math.min(1, left / total)) : 0;
    t.firstElementChild.style.transform = `scaleX(${frac})`;
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
