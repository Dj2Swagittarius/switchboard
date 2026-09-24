// Ringtones and notification sounds, synthesised with Web Audio (no audio
// files to ship), plus playback of a custom file the user picked in Settings.
// Include with <script src="/sounds.js"></script>; exposes window.switchboardSounds.
(() => {
  // ---- building blocks -------------------------------------------------------
  // A held tone (one or more frequencies) with short attack/release.
  function tone(ctx, out, freqs, t, dur, type = 'sine', gain = 1) {
    for (const f of freqs) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain / freqs.length, t + 0.012);
      g.gain.setValueAtTime(gain / freqs.length, t + Math.max(0.02, dur - 0.03));
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + dur + 0.02);
    }
  }
  // A struck note that decays (bell / marimba / ding).
  function pluck(ctx, out, f, t, dur, type = 'sine', gain = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.02);
  }
  // A tone that swells in and out.
  function swell(ctx, out, f, t, dur, gain = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + dur / 2);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.02);
  }
  // A quick pitch sweep (pop).
  function sweep(ctx, out, f0, f1, t, dur, gain = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur + 0.05);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.07);
  }
  // A soft low thump (knock).
  function thump(ctx, out, t, gain = 1.4) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.14);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.16);
  }

  // ---- presets ----------------------------------------------------------------
  // cycle: ms between repeats while ringing.
  const RING = {
    classic: { label: 'Classic', cycle: 6000, play: (c, o, t) => tone(c, o, [440, 480], t, 2.0) },
    double:  { label: 'Double ring', cycle: 3000, play: (c, o, t) => { tone(c, o, [400, 450], t, 0.4); tone(c, o, [400, 450], t + 0.6, 0.4); } },
    chime:   { label: 'Chime', cycle: 2600, play: (c, o, t) => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => pluck(c, o, f, t + i * 0.18, 1.2)) },
    marimba: { label: 'Marimba', cycle: 2400, play: (c, o, t) => [659.25, 783.99, 880, 783.99].forEach((f, i) => pluck(c, o, f, t + i * 0.16, 0.5, 'triangle', 1.3)) },
    digital: { label: 'Digital', cycle: 2000, play: (c, o, t) => { for (let i = 0; i < 4; i++) tone(c, o, [1000], t + i * 0.16, 0.08, 'square', 0.3); } },
    pulse:   { label: 'Soft pulse', cycle: 3000, play: (c, o, t) => swell(c, o, 660, t, 1.6) },
  };
  const MSG = {
    ding:    { label: 'Ding', play: (c, o, t) => { pluck(c, o, 1318.5, t, 0.9); pluck(c, o, 2637, t, 0.5, 'sine', 0.25); } },
    pop:     { label: 'Pop', play: (c, o, t) => sweep(c, o, 380, 950, t, 0.07) },
    chirp:   { label: 'Chirp', play: (c, o, t) => { pluck(c, o, 1200, t, 0.12); pluck(c, o, 1600, t + 0.1, 0.14); } },
    twotone: { label: 'Two-tone', play: (c, o, t) => { tone(c, o, [880], t, 0.14); tone(c, o, [660], t + 0.17, 0.18); } },
    knock:   { label: 'Knock', play: (c, o, t) => { thump(c, o, t); thump(c, o, t + 0.14); } },
    alert:   { label: 'Alert', play: (c, o, t) => { for (let i = 0; i < 3; i++) tone(c, o, [988], t + i * 0.18, 0.1, 'square', 0.3); } },
  };

  const CUSTOM_OK = /^custom-(ringtone|message|urgent)\.(mp3|wav|ogg|m4a)$/;
  const level = (volume) => Math.max(0, Math.min(100, Number(volume ?? 60))) / 100;

  function master(ctx, volume) {
    const g = ctx.createGain();
    g.gain.value = 0.14 * level(volume);
    g.connect(ctx.destination);
    return g;
  }

  // One-shot sound (message notifications, previews).
  function play({ name, file, volume } = {}) {
    if (!name || name === 'none' || level(volume) === 0) return;
    if (name === 'custom' && CUSTOM_OK.test(file || '')) {
      const a = new Audio('/sounds/' + file);
      a.volume = level(volume);
      a.play().catch(() => {});
      return;
    }
    const p = MSG[name] || MSG.ding;
    const ctx = new AudioContext();
    p.play(ctx, master(ctx, volume), ctx.currentTime + 0.02);
    setTimeout(() => ctx.close().catch(() => {}), 2500);
  }

  // Repeating ringtone. Returns a stop() function.
  function ring({ name, file, volume } = {}) {
    if (level(volume) === 0) return () => {};
    if (name === 'custom' && CUSTOM_OK.test(file || '')) {
      const a = new Audio('/sounds/' + file);
      a.loop = true;
      a.volume = level(volume);
      a.play().catch(() => {});
      return () => { a.pause(); a.src = ''; };
    }
    const p = RING[name] || RING.classic;
    const ctx = new AudioContext();
    const out = master(ctx, volume);
    const once = () => p.play(ctx, out, ctx.currentTime + 0.02);
    once();
    const timer = setInterval(once, p.cycle);
    return () => { clearInterval(timer); ctx.close().catch(() => {}); };
  }

  // Plays roughly one cycle of a ringtone, for the Settings preview.
  function previewRing(opts) {
    const stop = ring(opts);
    const p = RING[opts?.name];
    setTimeout(stop, opts?.name === 'custom' ? 4000 : Math.min(p ? p.cycle : 3000, 3200));
    return stop;
  }

  const labels = (set) => Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v.label]));
  window.switchboardSounds = { RING: labels(RING), MSG: labels(MSG), play, ring, previewRing };
})();
