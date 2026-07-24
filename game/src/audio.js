// =====================================================================
// Procedural placeholder audio (WebAudio synthesis — no asset files).
//
// To swap in real sounds, keep this class's API and replace the method
// bodies with sample playback:
//   setEngine(rpm 0..1, load 0..1)  — looping engine sample, pitch by rpm
//   setSkid(x 0..1)                 — looping tire screech, gain by x
//   setWind(x 0..1)                 — looping wind/road noise
//   thud(strength)                  — one-shot impact
//   beep(...) / fanfare()           — UI & race control sounds
// =====================================================================

import { CONFIG } from "../../shared/src/config.js";

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  // Must be called from a user gesture (menu click does it).
  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());

    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(ctx.destination);

    // --- engine: additive harmonic stack approximating a 4-stroke,
    // N-cylinder engine (see setEngine() + CONFIG.audio.engine). Each
    // harmonic order is its own oscillator+gain summed through one lowpass
    // (brightens with rpm/load) — nodes run continuously, setEngine() only retargets them.
    this.engLP = ctx.createBiquadFilter();
    this.engLP.type = "lowpass";
    this.engLP.frequency.value = 300;
    this.engLP.Q.value = 1;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engLP.connect(this.engGain);
    this.engGain.connect(this.master);

    const mkEngOsc = (type) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(this.engLP);
      osc.start();
      return { osc, gain };
    };
    this.engRumble = mkEngOsc("sawtooth"); // 1x — crank fundamental, low rumble
    this.engGrowl = mkEngOsc("sawtooth");  // firing order (cylinders/2 x) — the main engine tone
    this.engBody = mkEngOsc("sawtooth");   // 2x — fills out the tone
    this.engRasp = mkEngOsc("square");     // cylinders x — high-rev buzz/rasp

    // Amplitude-modulates the engine voice at the firing rate — the
    // "putter" of cylinder firings, audible at idle. Connected straight into
    // engGain's gain AudioParam (standard WebAudio tremolo hookup) — no JS-side retriggering needed.
    this.chugLFO = ctx.createOscillator();
    this.chugLFO.type = "sine";
    this.chugDepthGain = ctx.createGain();
    this.chugDepthGain.gain.value = 0;
    this.chugLFO.connect(this.chugDepthGain);
    this.chugDepthGain.connect(this.engGain.gain);
    this.chugLFO.start();

    // --- shared looping noise buffer ---
    const len = ctx.sampleRate * 2;
    const noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;

    // --- tire slide: bandpassed noise, the broad rubber-on-tarmac rumble ---
    this.skidSrc = ctx.createBufferSource();
    this.skidSrc.buffer = noiseBuf;
    this.skidSrc.loop = true;
    this.skidBP = ctx.createBiquadFilter();
    this.skidBP.type = "bandpass";
    this.skidBP.frequency.value = 750;
    this.skidBP.Q.value = 1.4;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidSrc.connect(this.skidBP);
    this.skidBP.connect(this.skidGain);
    this.skidGain.connect(this.master);
    this.skidSrc.start();

    // --- tire squeal: layered on top of the slide rumble above. A bandpass
    // alone (first attempt) was too subtle — a high-Q filter admits little
    // total energy from broadband noise, and the result got masked by the
    // slide/wind/engine layers sitting nearby. Real tire squeal reads as
    // tonal (a near-whine), not textured noise, so the audible part here is
    // two detuned oscillators (a genuine pitched "eeee"); the filtered noise
    // is kept underneath only for a bit of rasp, at low gain.
    // The oscillators do NOT go straight to master (raw saws at 1.5-3 kHz
    // sound like an alarm) — they pass through a resonant "formant"
    // bandpass tracking the squeal pitch, which strips the buzz down to a
    // hollow rubbery whine. All character params live in CONFIG.audio.squeal.
    this.squealOscA = ctx.createOscillator();
    this.squealOscA.type = "sawtooth";
    this.squealOscB = ctx.createOscillator();
    this.squealOscB.type = "sawtooth";
    this.squealToneGain = ctx.createGain();
    this.squealToneGain.gain.value = 0;
    this.squealFormant = ctx.createBiquadFilter();
    this.squealFormant.type = "bandpass";
    this.squealFormant.frequency.value = 1500;
    this.squealFormant.Q.value = 2.5;
    this.squealOscA.connect(this.squealToneGain);
    this.squealOscB.connect(this.squealToneGain);
    this.squealToneGain.connect(this.squealFormant);
    this.squealFormant.connect(this.master);
    this.squealOscA.start();
    this.squealOscB.start();

    // Stick-slip flutter: real squeal stutters irregularly as the contact
    // patch catches and lets go — a clean LFO can't fake that, so lowpassed
    // noise (~14 Hz movements) amplitude-modulates the whine instead.
    this.flutterSrc = ctx.createBufferSource();
    this.flutterSrc.buffer = noiseBuf;
    this.flutterSrc.loop = true;
    this.flutterLP = ctx.createBiquadFilter();
    this.flutterLP.type = "lowpass";
    this.flutterLP.frequency.value = 14;
    this.flutterDepthGain = ctx.createGain();
    this.flutterDepthGain.gain.value = 0;
    this.flutterSrc.connect(this.flutterLP);
    this.flutterLP.connect(this.flutterDepthGain);
    this.flutterDepthGain.connect(this.squealToneGain.gain);
    this.flutterSrc.start();

    this.squealSrc = ctx.createBufferSource();
    this.squealSrc.buffer = noiseBuf;
    this.squealSrc.loop = true;
    this.squealBP = ctx.createBiquadFilter();
    this.squealBP.type = "bandpass";
    this.squealBP.frequency.value = 2200;
    this.squealBP.Q.value = 5;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealSrc.connect(this.squealBP);
    this.squealBP.connect(this.squealGain);
    this.squealGain.connect(this.master);
    this.squealSrc.start();

    // Slow pitch wobble for the unsteady, "catching" quality real tire
    // squeal has — modulates both oscillators, the noise band, and the
    // formant together so the whole voice moves as one.
    this.squealLFO = ctx.createOscillator();
    this.squealLFO.type = "sine";
    this.squealLFO.frequency.value = 7;
    this.squealLFODepth = ctx.createGain();
    this.squealLFODepth.gain.value = 0; // scaled with slip amount in setSkid
    this.squealLFO.connect(this.squealLFODepth);
    this.squealLFODepth.connect(this.squealOscA.frequency);
    this.squealLFODepth.connect(this.squealOscB.frequency);
    this.squealLFODepth.connect(this.squealBP.frequency);
    this.squealLFODepth.connect(this.squealFormant.frequency);
    this.squealLFO.start();

    // --- wind/road noise ---
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = noiseBuf;
    this.windSrc.loop = true;
    this.windSrc.playbackRate.value = 0.6;
    const windLP = ctx.createBiquadFilter();
    windLP.type = "lowpass";
    windLP.frequency.value = 420;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(windLP);
    windLP.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSrc.start();
  }

  setEngine(rpm, load) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const E = CONFIG.audio.engine;
    const glide = E.pitchGlide;

    const crankHz = (E.idleRpm + rpm * (E.maxRpm - E.idleRpm)) / 60; // crank rotation freq — the "1x" order
    const firingMul = Math.max(1, E.cylinders / 2); // 4-stroke: cylinders/2 firings per revolution

    this.engRumble.osc.frequency.setTargetAtTime(crankHz, t, glide);
    this.engGrowl.osc.frequency.setTargetAtTime(crankHz * firingMul, t, glide);
    this.engBody.osc.frequency.setTargetAtTime(crankHz * 2, t, glide);
    this.engRasp.osc.frequency.setTargetAtTime(crankHz * E.cylinders, t, glide);
    this.chugLFO.frequency.setTargetAtTime(crankHz * firingMul, t, glide);

    this.engRumble.gain.gain.setTargetAtTime(E.rumbleGain, t, glide);
    this.engGrowl.gain.gain.setTargetAtTime(E.growlGain, t, glide);
    this.engBody.gain.gain.setTargetAtTime(E.bodyGain, t, glide);
    this.engRasp.gain.gain.setTargetAtTime(E.raspGain * rpm, t, glide); // buzz fades in with revs

    const baseGain = E.gainBase + load * E.gainLoad + rpm * 0.02;
    this.engGain.gain.setTargetAtTime(baseGain, t, 0.05);
    this.chugDepthGain.gain.setTargetAtTime(baseGain * E.chugDepth, t, 0.05);
    this.engLP.frequency.setTargetAtTime(E.toneCutoffBase + rpm * E.toneCutoffRpmGain + load * 400, t, 0.05);
  }

  setSkid(x) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const K = CONFIG.audio.skid;
    const S = CONFIG.audio.squeal;
    this.skidGain.gain.setTargetAtTime(x * K.gain, t, 0.05);
    this.skidBP.frequency.setTargetAtTime(K.freqBase + x * K.freqRise, t, 0.05);

    // Squeal ramps in once slip is clearly past "just scrubbing" (below
    // threshold it's silent, so light cornering stays just a slide) but
    // reaches full strength well before x maxes out, unlike an x*x curve
    // (which only opened up right at total lockup and was barely audible
    // in normal play).
    const squeal = Math.max(0, Math.min(1, (x - S.threshold) / S.range));
    const squealFreq = S.freqBase + x * S.freqRise;
    this.squealOscA.frequency.setTargetAtTime(squealFreq, t, 0.05);
    this.squealOscB.frequency.setTargetAtTime(squealFreq, t, 0.05);
    this.squealOscB.detune.setTargetAtTime(S.detune, t, 0.05);
    this.squealFormant.frequency.setTargetAtTime(squealFreq, t, 0.05);
    this.squealFormant.Q.setTargetAtTime(S.formantQ, t, 0.05);
    this.squealToneGain.gain.setTargetAtTime(squeal * S.toneGain, t, 0.04);
    this.squealGain.gain.setTargetAtTime(squeal * S.noiseGain, t, 0.04);
    this.squealBP.frequency.setTargetAtTime(squealFreq, t, 0.05);
    this.squealLFO.frequency.setTargetAtTime(S.vibratoRate, t, 0.05);
    this.squealLFODepth.gain.setTargetAtTime(squeal * S.vibratoDepth, t, 0.05);
    // lowpassed noise is low-amplitude, so the depth constant runs hot;
    // modulation is additive onto squealToneGain.gain around its base value
    this.flutterDepthGain.gain.setTargetAtTime(squeal * S.toneGain * S.flutterDepth * 6, t, 0.05);
  }

  setWind(x) {
    if (!this.ctx) return;
    this.windGain.gain.setTargetAtTime(0.1 * x * x, t0(this.ctx), 0.1);
  }

  thud(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = Math.min(1, strength);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 220 + s * 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * s, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.2);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(35, t + 0.15);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.4 * s, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(og); og.connect(this.master);
    osc.start(t); osc.stop(t + 0.18);
  }

  beep(freq, dur = 0.12, vol = 0.25, type = "square", when = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  fanfare() {
    [523, 659, 784, 1046].forEach((f, i) => this.beep(f, 0.3, 0.22, "triangle", i * 0.14));
  }

  click() {
    this.beep(620, 0.05, 0.12, "triangle");
  }

  stopRaceSounds() {
    this.setEngine(0, 0);
    this.setSkid(0);
    this.setWind(0);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.7;
    return this.muted;
  }

  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }
}

function t0(ctx) { return ctx.currentTime; }
