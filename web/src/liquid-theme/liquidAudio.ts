import type { LiquidAudioAdapter, LiquidDirection, LiquidStage } from './types';

export const SOUND_ENABLED_STORAGE_KEY = 'vibebaton.soundEnabled';
export const SOUND_VOLUME_STORAGE_KEY = 'vibebaton.soundVolume';
export const DEFAULT_SOUND_VOLUME = 0.45;

const MIN_GAIN = 1e-4;

export function readStoredSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SOUND_ENABLED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function readStoredSoundVolume(): number {
  if (typeof window === 'undefined') return DEFAULT_SOUND_VOLUME;
  try {
    const raw = window.localStorage.getItem(SOUND_VOLUME_STORAGE_KEY);
    if (raw === null) return DEFAULT_SOUND_VOLUME;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_SOUND_VOLUME;
    return Math.min(1, Math.max(0, parsed));
  } catch {
    return DEFAULT_SOUND_VOLUME;
  }
}

type ActiveHandle = {
  gainNode: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
};

export type AudioContextConstructor = new () => AudioContext;

export interface LiquidAudioEngineOptions {
  enabled?: boolean;
  volume?: number;
  getAudioContextCtor?: () => AudioContextConstructor | null;
}

function defaultAudioContextCtor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

export class LiquidWebAudioEngine implements LiquidAudioAdapter {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private masterGain: GainNode | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private enabled: boolean;
  private volume: number;
  private triggeredStages = new Set<LiquidStage>();
  private activeHandles = new Set<ActiveHandle>();
  private riseLoop: {
    source: AudioBufferSourceNode;
    filter: BiquadFilterNode;
    gainNode: GainNode;
    lfo: OscillatorNode;
    lfoGain: GainNode;
  } | null = null;
  private cleanupTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly getAudioContextCtor: () => AudioContextConstructor | null;

  constructor(options: LiquidAudioEngineOptions = {}) {
    this.enabled = options.enabled ?? readStoredSoundEnabled();
    this.volume = options.volume ?? readStoredSoundVolume();
    this.getAudioContextCtor = options.getAudioContextCtor ?? defaultAudioContextCtor;
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor = this.getAudioContextCtor();
      if (!Ctor) return null;
      const ctx = new Ctor();
      const masterGain = ctx.createGain();
      const masterFilter = ctx.createBiquadFilter();
      masterFilter.type = 'lowpass';
      masterFilter.frequency.setValueAtTime(7000, ctx.currentTime);
      masterGain.gain.setValueAtTime(0.18 * this.volume, ctx.currentTime);
      masterGain.connect(masterFilter);
      masterFilter.connect(ctx.destination);

      this.ctx = ctx;
      this.masterGain = masterGain;
      this.masterFilter = masterFilter;
      return ctx;
    } catch {
      return null;
    }
  }

  private ensureNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const sampleRate = ctx.sampleRate || 44100;
    const length = sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  private isAudible(): boolean {
    return this.enabled && this.volume > 0;
  }

  private pitchScale(direction: LiquidDirection): number {
    return direction === 'to-dark' ? 0.75 : 1.3;
  }

  private tuneMaster(ctx: AudioContext, direction: LiquidDirection): void {
    if (!this.masterGain || !this.masterFilter) return;
    const now = ctx.currentTime;
    const cutoff = direction === 'to-dark' ? 5500 : 9000;
    this.masterFilter.frequency.setTargetAtTime(cutoff, now, 0.04);
    this.masterGain.gain.setTargetAtTime(this.enabled ? 0.18 * this.volume : 0, now, 0.02);
  }

  unlock(): Promise<void> | void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') {
        return ctx.resume().catch(() => {});
      }
    } catch {
      // Audio playback failures must never interrupt theme switching.
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!this.isAudible()) {
      this.stopAllActive();
    } else if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(0.18 * this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : DEFAULT_SOUND_VOLUME));
    if (this.volume <= 0) {
      this.stopAllActive();
    } else if (this.ctx && this.masterGain && this.enabled) {
      this.masterGain.gain.setTargetAtTime(0.18 * this.volume, this.ctx.currentTime, 0.02);
    }
  }

  beginTransition(): void {
    this.triggeredStages.clear();
  }

  onStage(stage: LiquidStage, direction: LiquidDirection, progress: number): void {
    if (!this.isAudible()) return;
    if (stage === 'complete') return;
    if (this.triggeredStages.has(stage)) return;
    this.triggeredStages.add(stage);

    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    this.tuneMaster(ctx, direction);

    try {
      if (stage === 'pour') {
        this.playPour(ctx, direction);
      } else if (stage === 'splash') {
        this.playSplash(ctx, direction);
        this.startRiseBed(ctx, direction, progress);
      } else if (stage === 'rise' && !this.riseLoop) {
        this.startRiseBed(ctx, direction, progress);
      }
    } catch {
      // Ignore synthesis errors safely.
    }
  }

  onProgress(progress: number, direction: LiquidDirection): void {
    if (!this.isAudible() || !this.riseLoop || !this.ctx) return;
    const now = this.ctx.currentTime;
    const k = this.pitchScale(direction);
    const p = Math.min(1, Math.max(0, progress));
    this.riseLoop.filter.frequency.setTargetAtTime((300 + 900 * p) * k, now, 0.1);
    this.riseLoop.gainNode.gain.setTargetAtTime(0.035 * (1 - 0.6 * p), now, 0.1);
  }

  onComplete(direction: LiquidDirection): void {
    this.stopRiseBed();
    if (!this.isAudible() || this.triggeredStages.has('complete')) return;
    this.triggeredStages.add('complete');
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    this.tuneMaster(ctx, direction);
    try {
      this.playCompleteChime(ctx, direction);
    } catch {
      // Ignore synthesis errors cleanly.
    }
  }

  onInterrupt(): void {
    this.triggeredStages.clear();
    this.stopAllActive();
  }

  playReducedMotionCue(direction: LiquidDirection): void {
    if (!this.isAudible()) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    this.tuneMaster(ctx, direction);
    try {
      const now = ctx.currentTime;
      const k = this.pitchScale(direction);
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520 * k, now);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2000, now);
      gain.gain.setValueAtTime(MIN_GAIN, now);
      gain.gain.linearRampToValueAtTime(0.04, now + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + 0.09);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      const handle: ActiveHandle = { gainNode: gain, sources: [osc], nodes: [osc, filter, gain] };
      this.registerTransient(handle, 0.12);
      osc.start(now);
      osc.stop(now + 0.1);
    } catch {
      // Ignore synthesis errors cleanly.
    }
  }

  /** Plays a short (~650ms) audition snippet when the user clicks "Preview" in UI settings. */
  preview(direction: LiquidDirection): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    void this.unlock();
    const effectiveVolume = this.volume > 0 ? this.volume : DEFAULT_SOUND_VOLUME;
    const now = ctx.currentTime;
    const cutoff = direction === 'to-dark' ? 5500 : 9000;
    this.masterFilter?.frequency.setTargetAtTime(cutoff, now, 0.02);
    this.masterGain.gain.setTargetAtTime(0.18 * effectiveVolume, now, 0.01);

    try {
      this.stopAllActive();
      this.playPour(ctx, direction);
      this.playSplash(ctx, direction, now + 0.18);
      this.playCompleteChime(ctx, direction, now + 0.34);
    } catch {
      // Ignore synthesis errors safely.
    }
  }

  dispose(): void {
    this.stopAllActive();
    for (const timer of this.cleanupTimers) clearTimeout(timer);
    this.cleanupTimers.clear();
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        // Ignore close failures cleanly.
      }
      this.ctx = null;
      this.masterGain = null;
      this.masterFilter = null;
      this.noiseBuffer = null;
    }
  }

  private playPour(ctx: AudioContext, direction: LiquidDirection, startTime = ctx.currentTime): void {
    if (!this.masterGain) return;
    const k = this.pitchScale(direction);
    const buffer = this.ensureNoiseBuffer(ctx);

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900 * k, startTime);
    bp.Q.setValueAtTime(1.2, startTime);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(MIN_GAIN, startTime);
    noiseGain.gain.linearRampToValueAtTime(0.08, startTime + 0.04);
    noiseGain.gain.setTargetAtTime(MIN_GAIN, startTime + 0.25, 0.08);
    noise.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(this.masterGain);
    this.registerTransient({ gainNode: noiseGain, sources: [noise], nodes: [noise, bp, noiseGain] }, 0.65);
    noise.start(startTime);
    noise.stop(startTime + 0.6);

    const dropOsc = ctx.createOscillator();
    dropOsc.type = 'sine';
    dropOsc.frequency.setValueAtTime(420 * k, startTime);
    dropOsc.frequency.exponentialRampToValueAtTime(760 * k, startTime + 0.09);
    const dropGain = ctx.createGain();
    dropGain.gain.setValueAtTime(MIN_GAIN, startTime);
    dropGain.gain.linearRampToValueAtTime(0.06, startTime + 0.008);
    dropGain.gain.setTargetAtTime(MIN_GAIN, startTime + 0.03, 0.03);
    dropOsc.connect(dropGain);
    dropGain.connect(this.masterGain);
    this.registerTransient({ gainNode: dropGain, sources: [dropOsc], nodes: [dropOsc, dropGain] }, 0.25);
    dropOsc.start(startTime);
    dropOsc.stop(startTime + 0.2);
  }

  private playSplash(ctx: AudioContext, direction: LiquidDirection, startTime = ctx.currentTime): void {
    if (!this.masterGain) return;
    const k = this.pitchScale(direction);
    const buffer = this.ensureNoiseBuffer(ctx);

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1400 * k, startTime);
    bp.Q.setValueAtTime(0.8, startTime);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3500 * k, startTime);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(MIN_GAIN, startTime);
    gain.gain.linearRampToValueAtTime(0.12, startTime + 0.015);
    gain.gain.setTargetAtTime(MIN_GAIN, startTime + 0.04, 0.12);
    noise.connect(bp);
    bp.connect(lp);
    lp.connect(gain);
    gain.connect(this.masterGain);
    this.registerTransient({ gainNode: gain, sources: [noise], nodes: [noise, bp, lp, gain] }, 0.7);
    noise.start(startTime);
    noise.stop(startTime + 0.65);

    const pips: readonly [number, number][] = [
      [0.07, 650],
      [0.15, 980],
    ];
    for (const [offset, baseFreq] of pips) {
      const t = startTime + offset;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq * k, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.6 * k, t + 0.06);
      const pipGain = ctx.createGain();
      pipGain.gain.setValueAtTime(MIN_GAIN, t);
      pipGain.gain.linearRampToValueAtTime(0.04, t + 0.005);
      pipGain.gain.setTargetAtTime(MIN_GAIN, t + 0.015, 0.025);
      osc.connect(pipGain);
      pipGain.connect(this.masterGain);
      this.registerTransient({ gainNode: pipGain, sources: [osc], nodes: [osc, pipGain] }, offset + 0.25);
      osc.start(t);
      osc.stop(t + 0.18);
    }
  }

  private startRiseBed(ctx: AudioContext, direction: LiquidDirection, progress: number): void {
    if (!this.masterGain || this.riseLoop) return;
    const now = ctx.currentTime;
    const k = this.pitchScale(direction);
    const source = ctx.createBufferSource();
    source.buffer = this.ensureNoiseBuffer(ctx);
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime((300 + 900 * progress) * k, now);
    filter.Q.setValueAtTime(0.7, now);

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(MIN_GAIN, now);
    gainNode.gain.setTargetAtTime(0.035, now, 0.3);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(0.35, now);
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0.01, now);
    lfo.connect(lfoGain);
    lfoGain.connect(gainNode.gain);

    source.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(this.masterGain);
    source.start(now);
    lfo.start(now);

    this.riseLoop = { source, filter, gainNode, lfo, lfoGain };
  }

  private stopRiseBed(): void {
    if (!this.riseLoop || !this.ctx) return;
    const { source, lfo, gainNode, filter, lfoGain } = this.riseLoop;
    this.riseLoop = null;
    this.fadeOutAndDisconnect({ gainNode, sources: [source, lfo], nodes: [source, lfo, lfoGain, filter, gainNode] });
  }

  private playCompleteChime(
    ctx: AudioContext,
    direction: LiquidDirection,
    startTime = ctx.currentTime,
  ): void {
    if (!this.masterGain) return;
    const baseFreq = direction === 'to-dark' ? 392 : 659;
    const partials: readonly [number, number][] = [
      [1, 0.05],
      [1.5, 0.025],
      [2, 0.015],
    ];
    for (const [ratio, amp] of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq * ratio, startTime);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(MIN_GAIN, startTime);
      gain.gain.linearRampToValueAtTime(amp, startTime + 0.012);
      gain.gain.setTargetAtTime(MIN_GAIN, startTime + 0.02, 0.35);
      osc.connect(gain);
      gain.connect(this.masterGain);
      this.registerTransient({ gainNode: gain, sources: [osc], nodes: [osc, gain] }, 1.9);
      osc.start(startTime);
      osc.stop(startTime + 1.8);
    }
  }

  private registerTransient(handle: ActiveHandle, releaseAfterSec: number): void {
    this.activeHandles.add(handle);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      this.activeHandles.delete(handle);
      for (const node of handle.nodes) {
        try {
          node.disconnect();
        } catch {
          // Already disconnected.
        }
      }
    }, Math.ceil(releaseAfterSec * 1000) + 120);
    this.cleanupTimers.add(timer);
  }

  private fadeOutAndDisconnect(handle: ActiveHandle): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    try {
      handle.gainNode.gain.cancelScheduledValues(t);
      handle.gainNode.gain.setValueAtTime(handle.gainNode.gain.value, t);
      handle.gainNode.gain.linearRampToValueAtTime(0, t + 0.03);
      for (const src of handle.sources) {
        try {
          src.stop(t + 0.05);
        } catch {
          // Already stopped.
        }
      }
    } catch {
      // Ignore ramp errors.
    }
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      for (const node of handle.nodes) {
        try {
          node.disconnect();
        } catch {
          // Ignore disconnect errors.
        }
      }
    }, 80);
    this.cleanupTimers.add(timer);
  }

  private stopAllActive(): void {
    this.stopRiseBed();
    for (const handle of this.activeHandles) {
      this.fadeOutAndDisconnect(handle);
    }
    this.activeHandles.clear();
  }
}
