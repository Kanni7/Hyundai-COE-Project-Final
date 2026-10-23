// Generative in-car audio: royalty-free music synthesised live with Web Audio,
// plus horn and UI chimes. No audio files needed.

import type { Genre } from '../types';

interface Preset {
  bpm: number;
  chords: number[][];
  pad: OscillatorType;
  lead: OscillatorType;
  cutoff: number;
  kick: 'four' | 'half' | 'none';
  hats: boolean;
  snare: boolean;
  /** Chord-tone index per eighth note, -1 = rest. */
  arp: number[];
  leadDecay: number;
}

const PRESETS: Record<Genre, Preset> = {
  lofi: { bpm: 74, chords: [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]], pad: 'triangle', lead: 'sine', cutoff: 1100, kick: 'half', hats: true, snare: true, arp: [0, -1, 2, -1, 3, -1, 1, -1], leadDecay: 0.5 },
  romantic: { bpm: 66, chords: [[48, 52, 55, 60], [45, 48, 52, 57], [41, 45, 48, 53], [43, 47, 50, 55]], pad: 'sawtooth', lead: 'triangle', cutoff: 900, kick: 'none', hats: false, snare: false, arp: [0, 1, 2, 3, 2, 1, 0, 1], leadDecay: 0.7 },
  party: { bpm: 122, chords: [[45, 48, 52], [41, 45, 48], [48, 52, 55], [43, 47, 50]], pad: 'sawtooth', lead: 'square', cutoff: 2400, kick: 'four', hats: true, snare: true, arp: [0, 0, 1, 0, 2, 0, 1, 2], leadDecay: 0.18 },
  devotional: { bpm: 60, chords: [[50, 57, 62], [50, 57, 62], [48, 55, 60], [50, 57, 62]], pad: 'triangle', lead: 'sine', cutoff: 800, kick: 'none', hats: false, snare: false, arp: [2, -1, -1, 1, -1, -1, 0, -1], leadDecay: 1.6 },
  retro: { bpm: 98, chords: [[48, 52, 55], [52, 55, 59], [53, 57, 60], [55, 59, 62]], pad: 'square', lead: 'square', cutoff: 1400, kick: 'half', hats: true, snare: true, arp: [0, 1, 2, 1, 0, 1, 2, 1], leadDecay: 0.25 },
};

const midi = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Soft-clipping curve that gives the engine voice some bite. */
function driveCurve(k: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

interface EngineVoice {
  oscs: OscillatorNode[];
  sub: { o: OscillatorNode; order: number }[];
  subGain: GainNode;
  pre: GainNode;
  jitterDepth: GainNode;
  load: BiquadFilterNode;
  body: GainNode;
  out: GainNode;
  intakeBp: BiquadFilterNode;
  intake: GainNode;
  whineOsc: OscillatorNode;
  whine: GainNode;
}

class CarAudio {
  private ctx?: AudioContext;
  private master!: GainNode;
  private music!: GainNode;
  private tone!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private hiss?: AudioBufferSourceNode;
  analyser?: AnalyserNode;

  private timer?: number;
  private step = 0;
  private nextTime = 0;
  private preset: Preset = PRESETS.lofi;
  private transpose = 0;
  private volume = 0.4;
  private ducked = false;
  private relay?: number;
  private siren?: number;

  private ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.music = ctx.createGain();
    this.music.gain.value = 0;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 18000;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.78;
    this.music.connect(this.tone).connect(this.analyser).connect(this.master);
    this.master.connect(comp).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.ctx = ctx;
    return ctx;
  }

  /** Must run inside a user gesture once so browsers allow sound. */
  unlock() {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') void ctx.resume();
  }

  play(genre: Genre, track: number, radio: boolean) {
    const ctx = this.ensure();
    this.preset = PRESETS[genre];
    this.transpose = [0, 2, -3, 5][((track % 4) + 4) % 4];
    this.tone.frequency.setTargetAtTime(radio ? 3200 : 18000, ctx.currentTime, 0.05);
    this.setHiss(radio);
    if (this.timer === undefined) {
      this.step = 0;
      this.nextTime = ctx.currentTime + 0.08;
      this.timer = window.setInterval(() => this.schedule(), 25);
    }
    this.applyGain();
  }

  stop() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.setHiss(false);
    if (this.ctx) this.music.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  }

  setVolume(v: number) {
    this.volume = v;
    this.applyGain();
  }

  duck(on: boolean) {
    this.ducked = on;
    this.applyGain();
  }

  private applyGain() {
    if (!this.ctx || this.timer === undefined) return;
    const g = this.volume ** 1.6 * 0.9 * (this.ducked ? 0.35 : 1);
    this.music.gain.setTargetAtTime(g, this.ctx.currentTime, 0.12);
  }

  private setHiss(on: boolean) {
    if (!this.ctx) return;
    if (on && !this.hiss) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = 0.018;
      src.connect(g).connect(this.music);
      src.start();
      this.hiss = src;
    } else if (!on && this.hiss) {
      this.hiss.stop();
      this.hiss = undefined;
    }
  }

  private schedule() {
    const ctx = this.ctx!;
    const p = this.preset;
    const stepDur = 60 / p.bpm / 2;
    while (this.nextTime < ctx.currentTime + 0.15) {
      const pos = this.step % 8;
      const bar = Math.floor(this.step / 8);
      const chord = p.chords[bar % p.chords.length].map((n) => n + this.transpose);
      const t = this.nextTime;
      if (pos === 0) this.pad(chord, t, stepDur * 8);
      if (pos === 0 || pos === 4) this.voice(midi(chord[0] - 12), t, stepDur * 3, 'sine', 0.32, 0.01);
      const idx = p.arp[pos];
      if (idx >= 0) this.voice(midi(chord[idx % chord.length] + 12), t, p.leadDecay, p.lead, p.lead === 'square' ? 0.05 : 0.11, 0.005);
      if (p.kick === 'four' ? pos % 2 === 0 : p.kick === 'half' && (pos === 0 || pos === 4)) this.kick(t);
      if (p.snare && (pos === 2 || pos === 6)) this.hit(t, 1400, 0.24, 0.16);
      if (p.hats) this.hit(t, 7500, pos % 2 ? 0.05 : 0.09, 0.04);
      this.nextTime += stepDur;
      this.step++;
    }
  }

  private pad(chord: number[], t: number, dur: number) {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = this.preset.cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.35);
    g.gain.setValueAtTime(0.06, t + dur - 0.3);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.4);
    f.connect(g).connect(this.music);
    for (const n of chord) {
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = this.preset.pad;
        o.frequency.value = midi(n);
        o.detune.value = detune;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.5);
      }
    }
  }

  private voice(freq: number, t: number, dur: number, type: OscillatorType, gain: number, attack: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private kick(t: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.85, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + 0.35);
  }

  private hit(t: number, hp: number, gain: number, dur: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.music);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  private eng?: EngineVoice;

  /**
   * Cross-plane V8 heard from the cabin. Each oscillator plays one camshaft
   * cycle (720° of crank) built as a Fourier series of eight exhaust pulses,
   * 90° apart, in firing order 1-8-7-2-6-5-4-3. That order alternates banks
   * unevenly (L R L R R L R L); hearing one bank louder than the other leaves
   * strong low cam orders in the spectrum, which is the V8 burble. Filtered
   * noise jitters the amplitude like real combustion, then drive, a load filter
   * that opens with throttle, deep exhaust resonances and a cabin low-pass.
   */
  private engineVoice(): EngineVoice {
    if (this.eng) return this.eng;
    const ctx = this.ensure();
    const v8Wave = (near: number, far: number) => {
      const n = 120;
      const banks = [near, far, near, far, far, near, far, near];
      // Cylinder-to-cylinder spread in strength and timing keeps it organic.
      const trim = [1, 0.93, 1.07, 0.96, 1.04, 0.94, 1.03, 0.98];
      const skew = banks.map(() => (Math.random() - 0.5) * 0.008);
      const real = new Float32Array(n + 1);
      const imag = new Float32Array(n + 1);
      for (let k = 1; k <= n; k++) {
        const shape = 1 / (1 + (k / 17) ** 1.6); // rounded exhaust pulse rolls off the highs
        let re = 0;
        let im = 0;
        banks.forEach((a, i) => {
          const ph = -2 * Math.PI * k * (i / 8 + skew[i]);
          re += a * trim[i] * Math.cos(ph);
          im += a * trim[i] * Math.sin(ph);
        });
        real[k] = re * shape;
        imag[k] = im * shape;
      }
      return ctx.createPeriodicWave(real, imag);
    };

    const out = ctx.createGain();
    out.gain.value = 0;
    const cabin = ctx.createBiquadFilter();
    cabin.type = 'lowpass';
    cabin.frequency.value = 2200;
    cabin.Q.value = 0.5;
    cabin.connect(out).connect(this.master);

    const pre = ctx.createGain();
    const jitter = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(3);
    shaper.oversample = '2x';
    const load = ctx.createBiquadFilter();
    load.type = 'lowpass';
    load.Q.value = 0.9;
    const res1 = ctx.createBiquadFilter();
    res1.type = 'peaking';
    res1.frequency.value = 58;
    res1.Q.value = 1.1;
    res1.gain.value = 10;
    const res2 = ctx.createBiquadFilter();
    res2.type = 'peaking';
    res2.frequency.value = 115;
    res2.Q.value = 1;
    res2.gain.value = 6;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 140;
    shelf.gain.value = 5;
    const body = ctx.createGain();
    pre.connect(jitter).connect(shaper).connect(load).connect(res1).connect(res2).connect(shelf).connect(body).connect(cabin);

    // Near bank loud, far bank softer; a second voice with the banks swapped, slightly detuned, adds body.
    const oscs = ([[1, 0.55, 0, 0.75], [0.6, 1, 5, 0.45]] as const).map(([near, far, detune, level]) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(v8Wave(near, far));
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(pre);
      o.start();
      return o;
    });

    // Combustion irregularity: slow noise modulating the amplitude
    const noiseSrc = (rate = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.playbackRate.value = rate;
      src.start(0, Math.random());
      return src;
    };
    const jitterLp = ctx.createBiquadFilter();
    jitterLp.type = 'lowpass';
    jitterLp.frequency.value = 28;
    const jitterDepth = ctx.createGain();
    noiseSrc().connect(jitterLp).connect(jitterDepth).connect(jitter.gain);

    // Intake roar under load
    const intakeBp = ctx.createBiquadFilter();
    intakeBp.type = 'bandpass';
    intakeBp.Q.value = 1.4;
    const intake = ctx.createGain();
    intake.gain.value = 0;
    noiseSrc(0.9).connect(intakeBp).connect(intake).connect(cabin);

    // Sub-bass weight: pure tones at the firing frequency and half of it
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    subGain.connect(cabin);
    const sub = [8, 4].map((order, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.6 : 0.35;
      o.connect(g).connect(subGain);
      o.start();
      return { o, order };
    });

    // Faint timing-chain whine
    const whineOsc = ctx.createOscillator();
    whineOsc.type = 'sine';
    const whine = ctx.createGain();
    whine.gain.value = 0;
    whineOsc.connect(whine).connect(cabin);
    whineOsc.start();

    this.eng = { oscs, sub, subGain, pre, jitterDepth, load, body, out, intakeBp, intake, whineOsc, whine };
    return this.eng;
  }

  /** Updates the engine sound; rpm in thousands. Silent until audio is unlocked. */
  engine({ rpm, throttle, idle, running, cut }: { rpm: number; throttle: number; idle: number; running: boolean; cut: boolean }) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (!this.eng && rpm < 0.05) return;
    const e = this.engineVoice();
    const t = this.ctx.currentTime;
    const f0 = Math.max(0.5, (rpm * 1000) / 120); // camshaft frequency
    for (const o of e.oscs) o.frequency.setTargetAtTime(f0, t, 0.012);
    for (const { o, order } of e.sub) o.frequency.setTargetAtTime(f0 * order, t, 0.012);
    e.subGain.gain.setTargetAtTime(0.3 + throttle * 0.15, t, 0.05);
    const rev = Math.max(0, (rpm - idle) / (6.5 - idle));
    const drive = 0.7 + throttle * 2 + rev * 0.6;
    e.pre.gain.setTargetAtTime(drive, t, 0.03);
    e.body.gain.setTargetAtTime(1 / drive ** 0.65, t, 0.03);
    e.jitterDepth.gain.setTargetAtTime(0.3 - rev * 0.2, t, 0.1);
    e.load.frequency.setTargetAtTime(200 + rpm * 240 + throttle * 1600, t, 0.04);
    e.intakeBp.frequency.setTargetAtTime(180 + rpm * 170, t, 0.05);
    e.intake.gain.setTargetAtTime(throttle * 0.08 * (0.3 + rpm / 6.5), t, 0.06);
    e.whineOsc.frequency.setTargetAtTime(f0 * 48, t, 0.02);
    e.whine.gain.setTargetAtTime(0.0011 * Math.min(1, rpm / 6), t, 0.1);
    let level = running ? 0.14 + rev * 0.28 + throttle * 0.07 : 0.14 * Math.min(1, rpm / Math.max(idle, 0.1));
    if (cut) level *= 0.45;
    e.out.gain.setTargetAtTime(Math.min(0.48, level), t, cut ? 0.008 : 0.045);
  }

  /** Starter motor: whine plus compression thumps, before the engine catches. */
  engineStart() {
    const ctx = this.ensure();
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const dur = 0.62;
    const motor = ctx.createOscillator();
    motor.type = 'sawtooth';
    motor.frequency.setValueAtTime(120, t);
    motor.frequency.linearRampToValueAtTime(200, t + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.04);
    g.gain.setValueAtTime(0.045, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    motor.connect(bp).connect(g).connect(this.master);
    motor.start(t);
    motor.stop(t + dur + 0.1);
    // Each compression stroke loads the starter: a low thump
    for (let i = 0; i < 6; i++) {
      const tt = t + 0.04 + i * 0.105;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(58, tt);
      o.frequency.exponentialRampToValueAtTime(30, tt + 0.1);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0001, tt);
      tg.gain.linearRampToValueAtTime(0.22, tt + 0.008);
      tg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.11);
      o.connect(tg).connect(this.master);
      o.start(tt);
      o.stop(tt + 0.13);
    }
  }

  /** Exhaust pops and burble when lifting off the throttle at high revs. */
  overrun(intensity: number) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    let tt = ctx.currentTime + 0.06;
    const pops = 8 + Math.round(intensity * 14);
    for (let i = 0; i < pops; i++) {
      tt += 0.035 + Math.random() * 0.11;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 350 + Math.random() * 700;
      bp.Q.value = 0.8;
      const g = ctx.createGain();
      const peak = (0.04 + Math.random() * 0.12) * intensity * (1 - i / (pops + 2));
      const len = 0.02 + Math.random() * 0.04;
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.linearRampToValueAtTime(peak, tt + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + len);
      src.connect(bp).connect(g).connect(this.master);
      src.start(tt, Math.random() * 0.8);
      src.stop(tt + len + 0.02);
      if (Math.random() < 0.35) {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(75, tt);
        o.frequency.exponentialRampToValueAtTime(45, tt + 0.05);
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.0001, tt);
        og.gain.linearRampToValueAtTime(peak * 1.2, tt + 0.004);
        og.gain.exponentialRampToValueAtTime(0.0001, tt + 0.06);
        o.connect(og).connect(this.master);
        o.start(tt);
        o.stop(tt + 0.08);
      }
    }
  }

  horn() {
    const ctx = this.ensure();
    const t = ctx.currentTime;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.02);
    g.gain.setValueAtTime(0.32, t + 0.38);
    g.gain.linearRampToValueAtTime(0, t + 0.46);
    f.connect(g).connect(this.master);
    for (const hz of [415, 523]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.connect(f);
      o.start(t);
      o.stop(t + 0.5);
    }
  }

  /**
   * Flasher relay for the hazards and indicators: a sharp "tick" as the lamps light and a
   * softer "tock" as they go out, every half second, in step with the blinking lamps.
   */
  flasher(on: boolean) {
    if (on === (this.relay !== undefined)) return;
    if (!on) {
      window.clearInterval(this.relay);
      this.relay = undefined;
      return;
    }
    let lit = true;
    this.click(lit);
    this.relay = window.setInterval(() => { lit = !lit; this.click(lit); }, 500);
  }

  /** One relay click: a very short band-passed noise burst over a faint low knock. */
  private click(tick: boolean) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = tick ? 2600 : 1700;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(tick ? 0.32 : 0.2, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.05);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(tick ? 190 : 150, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.025);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.08, t + 0.002);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.05);
  }

  /** Drowsiness warning: a loud, urgent two-tone beep every 0.7 s until turned off; music is ducked meanwhile. */
  alarm(on: boolean) {
    if (on === (this.siren !== undefined)) return;
    if (!on) {
      window.clearInterval(this.siren);
      this.siren = undefined;
      this.duck(false);
      return;
    }
    this.unlock();
    this.duck(true);
    const beep = () => {
      const ctx = this.ensure();
      [1760, 1320].forEach((hz, i) => {
        const t = ctx.currentTime + i * 0.16;
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = hz;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.22, t + 0.01);
        g.gain.setValueAtTime(0.22, t + 0.12);
        g.gain.linearRampToValueAtTime(0.0001, t + 0.14);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + 0.15);
      });
    };
    beep();
    this.siren = window.setInterval(beep, 700);
  }

  chime(kind: 'listen' | 'ok' | 'error') {
    const ctx = this.ensure();
    const notes = { listen: [660, 990], ok: [880, 1320], error: [392, 294] }[kind];
    notes.forEach((hz, i) => {
      const t = ctx.currentTime + i * 0.09;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.4);
    });
  }
}

export const carAudio = new CarAudio();
