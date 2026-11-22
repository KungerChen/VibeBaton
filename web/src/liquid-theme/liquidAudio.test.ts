import { describe, expect, test, vi } from 'vitest';
import { LiquidWebAudioEngine, readStoredSoundEnabled, readStoredSoundVolume } from './liquidAudio';

function makeMockAudioContextClass() {
  const oscStopCalls = { count: 0 };
  const rampCalls: number[] = [];

  class FakeAudioParam {
    value = 0;
    setValueAtTime = vi.fn((v: number) => {
      this.value = v;
    });
    linearRampToValueAtTime = vi.fn((v: number) => {
      this.value = v;
      rampCalls.push(v);
    });
    exponentialRampToValueAtTime = vi.fn((v: number) => {
      this.value = v;
    });
    setTargetAtTime = vi.fn((v: number) => {
      this.value = v;
    });
    cancelScheduledValues = vi.fn();
  }

  class FakeAudioContext {
    currentTime = 1;
    sampleRate = 44100;
    state: AudioContextState = 'suspended';
    destination = {} as AudioDestinationNode;

    resume = vi.fn(async () => {
      this.state = 'running';
    });
    close = vi.fn(async () => {
      this.state = 'closed';
    });
    createBuffer = vi.fn((_ch: number, len: number) => ({
      getChannelData: () => new Float32Array(len),
    }));
    createBufferSource = vi.fn(() => ({
      buffer: null as AudioBuffer | null,
      loop: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(() => {
        oscStopCalls.count += 1;
      }),
    }));
    createBiquadFilter = vi.fn(() => ({
      type: 'lowpass' as BiquadFilterType,
      frequency: new FakeAudioParam(),
      Q: new FakeAudioParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    createGain = vi.fn(() => ({
      gain: new FakeAudioParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    createOscillator = vi.fn(() => ({
      type: 'sine' as OscillatorType,
      frequency: new FakeAudioParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(() => {
        oscStopCalls.count += 1;
      }),
    }));
  }

  return { FakeAudioContext, oscStopCalls, rampCalls };
}

describe('LiquidWebAudioEngine', () => {
  test('defaults to sound OFF and safe default volume', () => {
    expect(readStoredSoundEnabled()).toBe(false);
    expect(readStoredSoundVolume()).toBe(0.45);
  });

  test('does not synthesize audio when disabled, and unlocks cleanly when enabled', async () => {
    const { FakeAudioContext } = makeMockAudioContextClass();
    let created = 0;
    const engine = new LiquidWebAudioEngine({
      enabled: false,
      volume: 0.5,
      getAudioContextCtor: () => {
        created += 1;
        return FakeAudioContext as unknown as new () => AudioContext;
      },
    });

    engine.onStage('pour', 'to-light', 0.05);
    expect(created).toBe(0);

    engine.setEnabled(true);
    await engine.unlock();
    expect(created).toBe(1);

    engine.beginTransition();
    engine.onStage('pour', 'to-light', 0.05);
    engine.onStage('pour', 'to-light', 0.1);
    engine.onStage('splash', 'to-light', 0.3);
    engine.onProgress(0.65, 'to-light');
    engine.onComplete('to-light');
    engine.dispose();
  });

  test('interrupt stops active sounds cleanly without firing completion chime', () => {
    const { FakeAudioContext, oscStopCalls, rampCalls } = makeMockAudioContextClass();
    const instances: InstanceType<typeof FakeAudioContext>[] = [];
    const engine = new LiquidWebAudioEngine({
      enabled: true,
      volume: 0.6,
      getAudioContextCtor: () =>
        class extends FakeAudioContext {
          constructor() {
            super();
            instances.push(this);
          }
        } as unknown as new () => AudioContext,
    });

    engine.beginTransition();
    engine.onStage('pour', 'to-dark', 0.05);
    engine.onStage('splash', 'to-dark', 0.3);
    const oscBeforeInterrupt = instances[0].createOscillator.mock.calls.length;

    engine.onInterrupt();
    expect(oscStopCalls.count).toBeGreaterThan(0);
    expect(rampCalls).toContain(0);
    expect(instances[0].createOscillator.mock.calls.length).toBe(oscBeforeInterrupt);

    engine.setVolume(0);
    engine.playReducedMotionCue('to-dark');
    engine.dispose();
  });

  test('degrades cleanly when AudioContext is unavailable or throws', () => {
    const engine = new LiquidWebAudioEngine({
      enabled: true,
      volume: 0.5,
      getAudioContextCtor: () => {
        throw new Error('AudioContext blocked');
      },
    });

    expect(() => engine.unlock()).not.toThrow();
    expect(() => engine.onStage('pour', 'to-light', 0.1)).not.toThrow();
    expect(() => engine.onComplete('to-light')).not.toThrow();
    expect(() => engine.playReducedMotionCue('to-dark')).not.toThrow();
    expect(() => engine.preview('to-light')).not.toThrow();
    expect(() => engine.dispose()).not.toThrow();
  });
});
