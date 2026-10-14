'use strict';
// Música de fondo generada en el navegador con Web Audio (sin archivos).
// "calm" para el lobby, "tense" durante las partidas (suma bombo y hi-hat).
window.Music = (() => {
  const BPM = 88;
  const STEP = 60 / BPM / 2; // corcheas
  const SWING = 0.16;
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // [raíz MIDI, intervalos del acorde]
  const PROG = [
    [57, [0, 3, 7, 10]], // Am7
    [62, [0, 3, 7, 10]], // Dm7
    [55, [0, 4, 7, 10]], // G7
    [60, [0, 4, 7, 11]], // Cmaj7
    [53, [0, 4, 7, 11]], // Fmaj7
    [59, [0, 3, 6, 10]], // Bm7b5
    [52, [0, 4, 7, 10]], // E7
    [57, [0, 3, 7, 10]], // Am7
  ];
  const ARP = [0, 2, 1, 3, 2, 1, 3, 2];
  // melodía simple (grados de la escala de La menor), null = silencio
  const SCALE = [69, 71, 72, 74, 76, 77, 79, 81];
  const MELODY = [
    [4, null, 3, 2, null, 1, 2, null], [3, null, null, 5, 4, 3, null, null],
    [1, null, 2, 3, null, 4, 3, null], [2, null, null, null, 0, null, null, null],
    [5, null, 4, 3, null, 2, 3, null], [1, null, null, 2, 3, null, 1, null],
    [0, null, 1, 2, null, 1, null, null], [0, null, null, null, null, null, null, null],
  ];

  let ctx = null, master, bus, timer = null, playing = false;
  let nextTime = 0, step = 0, mood = 'calm', noiseBuf = null;

  function init(c) {
    ctx = c;
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    bus = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(2.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    bus.connect(master);
    bus.connect(reverb).connect(wet).connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function impulse(sec) {
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return b;
  }

  function voice(type, freq, t, dur, vol, { attack = 0.01, cutoff = 4000, detune = 0, sustain = false } = {}) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    if (sustain) {
      g.gain.setValueAtTime(vol, t + dur - 0.4);
      g.gain.linearRampToValueAtTime(0, t + dur);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    o.connect(f).connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function pad([root, iv], t, dur) {
    for (const i of iv) {
      const f = midi(root + i);
      voice('sawtooth', f, t, dur, 0.018, { attack: 0.5, cutoff: 800, detune: -7, sustain: true });
      voice('triangle', f, t, dur, 0.026, { attack: 0.5, cutoff: 1400, detune: 7, sustain: true });
    }
  }
  const bass = (f, t) => { voice('triangle', f, t, 0.5, 0.17, { attack: 0.005, cutoff: 500 }); voice('sine', f, t, 0.55, 0.12); };
  const pluck = (f, t, vol) => voice('triangle', f, t, 0.4, vol, { attack: 0.003, cutoff: 3200 });
  const lead = (f, t) => voice('sine', f, t, 0.7, 0.05, { attack: 0.02 });

  function hat(t, vol) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    s.connect(f).connect(g).connect(bus);
    s.start(t);
    s.stop(t + 0.08);
  }

  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.32);
  }

  function scheduleStep(s, t) {
    const bar = Math.floor(s / 8) % PROG.length;
    const beat = s % 8;
    const chord = PROG[bar];
    const [root, iv] = chord;
    const tense = mood === 'tense';

    if (beat === 0) pad(chord, t, STEP * 8 + 0.3);
    if (beat === 0) bass(midi(root - 24), t);
    if (beat === 4) bass(midi(root - 24 + 7), t);
    if (tense && beat === 6) bass(midi(root - 24 + iv[2]), t);

    if (Math.random() < (tense ? 0.85 : 0.55)) {
      pluck(midi(root + 12 + iv[ARP[beat] % iv.length]), t, beat % 2 ? 0.035 : 0.055);
    }
    // la melodía aparece en vueltas alternas para no cansar
    if (Math.floor(s / 64) % 2 === 1) {
      const deg = MELODY[bar][beat];
      if (deg !== null) lead(midi(SCALE[deg]), t);
    }
    if (tense) {
      if (beat === 0 || beat === 4) kick(t);
      if (beat % 2 === 1) hat(t, 0.05);
    } else if (beat % 2 === 1 && Math.random() < 0.4) {
      hat(t, 0.02);
    }
  }

  function tick() {
    const ahead = document.hidden ? 1.5 : 0.2;
    while (nextTime < ctx.currentTime + ahead) {
      scheduleStep(step, nextTime + (step % 2 ? STEP * SWING : 0));
      nextTime += STEP;
      step++;
    }
  }

  function fade(to, secs) {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(to, now + secs);
  }

  return {
    start(c) {
      if (!ctx) init(c);
      if (playing) return;
      playing = true;
      nextTime = Math.max(nextTime, ctx.currentTime + 0.1);
      fade(0.55, 1.5);
      clearInterval(timer);
      timer = setInterval(tick, 40);
    },
    stop() {
      if (!playing) return;
      playing = false;
      fade(0, 0.6);
      setTimeout(() => { if (!playing) clearInterval(timer); }, 700);
    },
    setMood(m) { mood = m; },
    get playing() { return playing; },
  };
})();
