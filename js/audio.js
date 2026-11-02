/** Web Audio API sound effects synthesized at runtime for the Dino game. */

const DEFAULT_VOLUME = 0.35;
const MIN_GAIN = 0.0001;

/**
 * AudioManager creates one AudioContext lazily. Call `resume()` from a trusted
 * user action (for example, the start/jump input handler) before playing sound.
 */
export class AudioManager {
  constructor({ AudioContextClass = null, volume = DEFAULT_VOLUME, muted = false } = {}) {
    this.AudioContextClass = AudioContextClass;
    this.context = null;
    this.masterGain = null;
    this.activeVoices = new Set();
    this.volume = clamp(finiteOr(volume, DEFAULT_VOLUME), 0, 1);
    this.muted = Boolean(muted);
    this.unlocked = false;
    this.disposed = false;
    this.supported = null;
  }

  /** Create the context and master gain once; does not resume or play audio. */
  init() {
    if (this.disposed) return false;
    if (this.context && this.masterGain) return true;

    const ContextClass = this.AudioContextClass ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof ContextClass !== "function") {
      this.supported = false;
      return false;
    }

    let context;
    try {
      context = new ContextClass();
      const master = context.createGain();
      master.gain.setValueAtTime(this.muted ? 0 : this.volume, context.currentTime);
      master.connect(context.destination);
      this.context = context;
      this.masterGain = master;
      this.supported = true;
      return true;
    } catch {
      this.supported = false;
      try { context?.close?.(); } catch { /* Audio must never break gameplay. */ }
      return false;
    }
  }

  /**
   * Unlock/resume audio. The game should call this from a user-initiated event;
   * merely calling init() at page load leaves the context suspended.
   */
  async resume() {
    if (!this.init()) return false;
    this.unlocked = true;
    if (this.context.state === "running") return true;

    try {
      await this.context.resume();
      return this.context.state === "running";
    } catch {
      return false;
    }
  }

  playJump() {
    return this._playEffect(() => this._tone({
      waveform: "triangle", startHz: 285, endHz: 610, duration: 0.14,
      peak: 0.28, attack: 0.012,
    }));
  }

  playLand() {
    return this._playEffect(() => this._tone({
      waveform: "sine", startHz: 155, endHz: 78, duration: 0.105,
      peak: 0.3, attack: 0.004, filterHz: 520,
    }));
  }

  playCollision() {
    return this._playEffect(() => this._tone({
      waveform: "sawtooth", startHz: 245, endHz: 52, duration: 0.28,
      peak: 0.34, attack: 0.008, filterHz: 1050,
    }));
  }

  playScore() {
    return this._playEffect(() => {
      const first = this._tone({
        waveform: "triangle", startHz: 740, endHz: 880, duration: 0.11,
        peak: 0.17, attack: 0.006,
      });
      const second = this._tone({
        waveform: "sine", startHz: 988, endHz: 1318, duration: 0.2,
        peak: 0.2, attack: 0.008, delay: 0.075,
      });
      return first || second;
    });
  }

  playUI() {
    return this._playEffect(() => this._tone({
      waveform: "square", startHz: 920, endHz: 650, duration: 0.065,
      peak: 0.11, attack: 0.003, filterHz: 2600,
    }));
  }

  playFinalScene() {
    return this._playEffect(() => {
      const notes = [
        { frequency: 523.25, delay: 0 },
        { frequency: 659.25, delay: 0.12 },
        { frequency: 783.99, delay: 0.24 },
      ];
      let played = false;
      for (const note of notes) {
        played = this._tone({
          waveform: "sine", startHz: note.frequency, endHz: note.frequency * 1.015,
          duration: 0.62, peak: 0.13, attack: 0.035, delay: note.delay,
        }) || played;
      }
      return played;
    });
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this._updateMasterGain();
    return this.muted;
  }

  toggleMuted() {
    return this.setMuted(!this.muted);
  }

  /** Set master volume in the inclusive range [0, 1]. */
  setVolume(volume) {
    if (!Number.isFinite(volume)) return false;
    this.volume = clamp(volume, 0, 1);
    this._updateMasterGain();
    return this.volume;
  }

  /** Stop active voices and release the context. Safe to call more than once. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unlocked = false;

    for (const voice of this.activeVoices) this._releaseVoice(voice, true);
    this.activeVoices.clear();
    try { this.masterGain?.disconnect(); } catch { /* Already disconnected. */ }
    this.masterGain = null;

    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") {
      try { Promise.resolve(context.close()).catch(() => {}); } catch { /* Best effort cleanup. */ }
    }
  }

  _playEffect(schedule) {
    if (this.disposed || this.muted || !this.unlocked || !this.context || !this.masterGain) {
      return false;
    }
    if (this.context.state === "running") return schedule();

    // A context previously unlocked by a user may be suspended by the browser.
    this.resume().then((ready) => {
      if (ready && !this.muted && !this.disposed) schedule();
    }).catch(() => {});
    return true;
  }

  _tone({ waveform, startHz, endHz, duration, peak, attack, delay = 0, filterHz = null }) {
    const context = this.context;
    if (!context || !this.masterGain || context.state !== "running") return false;

    let oscillator;
    let envelope;
    let filter;
    const voice = { oscillator: null, envelope: null, filter: null };
    try {
      oscillator = context.createOscillator();
      envelope = context.createGain();
      voice.oscillator = oscillator;
      voice.envelope = envelope;
      oscillator.type = waveform;
      oscillator.frequency.setValueAtTime(startHz, context.currentTime + delay);
      if (startHz !== endHz) {
        oscillator.frequency.exponentialRampToValueAtTime(endHz, context.currentTime + delay + duration);
      }

      if (filterHz) {
        filter = context.createBiquadFilter();
        voice.filter = filter;
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(filterHz, context.currentTime + delay);
        oscillator.connect(filter);
        filter.connect(envelope);
      } else {
        oscillator.connect(envelope);
      }
      envelope.connect(this.masterGain);

      const startAt = context.currentTime + delay;
      const endAt = startAt + duration;
      envelope.gain.setValueAtTime(MIN_GAIN, startAt);
      envelope.gain.linearRampToValueAtTime(peak, startAt + Math.min(attack, duration * 0.45));
      envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, endAt);

      voice.oscillator.onended = () => this._releaseVoice(voice);
      this.activeVoices.add(voice);
      oscillator.start(startAt);
      oscillator.stop(endAt + 0.01);
      return true;
    } catch {
      this._releaseVoice(voice, true);
      return false;
    }
  }

  _releaseVoice(voice, stop = false) {
    if (!voice || !this.activeVoices.has(voice)) {
      if (!stop) return;
    }
    this.activeVoices.delete(voice);
    if (stop) {
      try { voice.oscillator?.stop(); } catch { /* It may not have started or may have ended. */ }
    }
    try { voice.oscillator?.disconnect(); } catch { /* Best effort node cleanup. */ }
    try { voice.filter?.disconnect(); } catch { /* Best effort node cleanup. */ }
    try { voice.envelope?.disconnect(); } catch { /* Best effort node cleanup. */ }
  }

  _updateMasterGain() {
    if (!this.context || !this.masterGain) return;
    try {
      const target = this.muted ? 0 : this.volume;
      this.masterGain.gain.setTargetAtTime(target, this.context.currentTime, 0.015);
    } catch {
      try { this.masterGain.gain.value = this.muted ? 0 : this.volume; } catch { /* Ignore audio setting failures. */ }
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export default AudioManager;
