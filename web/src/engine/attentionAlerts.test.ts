import { describe, expect, test, vi } from 'vitest';
import {
  readStoredSoundEnabled,
  readStoredSoundVolume,
  SOUND_ENABLED_STORAGE_KEY,
  SOUND_VOLUME_STORAGE_KEY,
} from '../liquid-theme/liquidAudio';
import type { LiveRunSnapshot, RunAttentionState, RunTelemetry } from '../types/graph';
import {
  buildAlertFingerprint,
  deriveAttentionAlert,
  dispatchBrowserNotification,
  formatAttentionDocumentTitle,
  playAttentionChime,
} from './attentionAlerts';

const runningSnapshot: LiveRunSnapshot = {
  run: { id: 'run-1', status: 'RUNNING' },
  milestones: [],
  tasks: [],
  events: [],
  quotas: [],
};
const telemetry: RunTelemetry = { elapsed_sec: 20, stages: [], models: [] };
const alert: RunAttentionState = {
  category: 'waiting_human',
  severity: 'warning',
  title: 'Resolve the merge blocker',
  message: 'Task M1-T1 exhausted its merge attempts.',
  action_hint: 'Review and resolve the blocker in Studio.',
  milestone_id: 'M1',
  task_id: 'M1-T1',
  created_at: 120.125,
};

describe('deriveAttentionAlert', () => {
  test('prefers attention from v1.0.2 telemetry over a legacy status', () => {
    const snapshot: LiveRunSnapshot = {
      ...runningSnapshot,
      run: { id: 'run-1', status: 'WAITING_HUMAN', human_prompt: 'Older prompt' },
      telemetry: { ...telemetry, attention: alert },
    };

    expect(deriveAttentionAlert(snapshot)).toBe(alert);
  });

  test('uses the human prompt before the summary for legacy WAITING_HUMAN', () => {
    const snapshot: LiveRunSnapshot = {
      ...runningSnapshot,
      run: {
        id: 'run-1',
        status: 'WAITING_HUMAN',
        human_prompt: ' Review the merge blocker. ',
        summary: 'Task M1-T1 stopped.',
        created_at: 0,
      },
      telemetry,
    };

    expect(deriveAttentionAlert(snapshot)).toEqual({
      category: 'waiting_human',
      severity: 'warning',
      title: 'Human decision required',
      message: 'Review the merge blocker.',
      action_hint: 'Review and resolve the blocker in Studio.',
      milestone_id: null,
      task_id: null,
      created_at: 0,
    });
  });

  test.each([
    ['READY_FOR_FINAL_GATE', 'ready_for_final_gate', 'info'],
    ['FAILED', 'failed', 'error'],
    ['PAUSED', 'paused', 'warning'],
  ])('uses the run summary for legacy %s', (status, category, severity) => {
    const snapshot: LiveRunSnapshot = {
      ...runningSnapshot,
      run: { status, summary: 'Recorded run summary.', created_at: 10, updated_at: 20 },
    };

    expect(deriveAttentionAlert(snapshot)).toMatchObject({
      category, severity, message: 'Recorded run summary.', created_at: 20,
    });
  });

  test('synthesizes a detail from the status when the legacy run has no text', () => {
    expect(deriveAttentionAlert({ ...runningSnapshot, run: { status: 'FAILED' } })).toMatchObject({
      title: 'Run failed', message: 'The run stopped because of an error.', created_at: null,
    });
  });

  test('returns null for active or missing runs without attention', () => {
    expect(deriveAttentionAlert(runningSnapshot)).toBeNull();
    expect(deriveAttentionAlert({ ...runningSnapshot, telemetry: { ...telemetry, attention: null } })).toBeNull();
    expect(deriveAttentionAlert({ ...runningSnapshot, run: null })).toBeNull();
    expect(deriveAttentionAlert(null)).toBeNull();
  });
});

describe('buildAlertFingerprint', () => {
  test('identifies the episode independently of detail text', () => {
    const fingerprint = 'run-1|waiting_human|M1|M1-T1|120.125';
    expect(buildAlertFingerprint('run-1', alert)).toBe(fingerprint);
    expect(buildAlertFingerprint('run-1', { ...alert, message: 'Updated detail.' })).toBe(fingerprint);
    expect(buildAlertFingerprint('run-1', { ...alert, created_at: 121 })).not.toBe(fingerprint);
  });

  test('uses empty slots for null metadata and preserves epoch zero', () => {
    const withoutIds = { ...alert, milestone_id: null, task_id: null };
    expect(buildAlertFingerprint('run-1', { ...withoutIds, created_at: 0 })).toBe('run-1|waiting_human|||0');
    expect(buildAlertFingerprint('run-1', { ...withoutIds, created_at: null })).toBe('run-1|waiting_human|||');
  });

  test('requires both a run ID and an alert', () => {
    expect(buildAlertFingerprint('run-1', null)).toBeNull();
    expect(buildAlertFingerprint(null, alert)).toBeNull();
    expect(buildAlertFingerprint(undefined, alert)).toBeNull();
  });
});

describe('formatAttentionDocumentTitle', () => {
  const base = 'VibeBaton Studio';

  test('alternates the full alert and the warning prefix', () => {
    expect(formatAttentionDocumentTitle(base, alert, 'en', true)).toBe('[⚠ Resolve the merge blocker] · VibeBaton Studio');
    expect(formatAttentionDocumentTitle(base, alert, 'en', false)).toBe('[⚠] · VibeBaton Studio');
    expect(formatAttentionDocumentTitle(base, { ...alert, title: '' }, 'zh', true)).toBe('[⚠ 提醒 等待人工裁决] · VibeBaton Studio');
  });

  test.each([true, false])('restores the base title with no alert on tick %s', (tickOdd) => {
    expect(formatAttentionDocumentTitle(base, null, 'en', tickOdd)).toBe(base);
  });
});

describe('dispatchBrowserNotification', () => {
  function recordNotifications() {
    const calls: { title: string; options?: NotificationOptions }[] = [];
    class RecordingNotification {
      constructor(title: string, options?: NotificationOptions) {
        calls.push({ title, options });
      }
    }
    return { calls, NotificationCtor: RecordingNotification as unknown as typeof Notification };
  }

  test('uses the alert title and detail when permission is granted', () => {
    const { calls, NotificationCtor } = recordNotifications();

    expect(dispatchBrowserNotification(alert, 'en', 'granted', NotificationCtor)).toBe(true);
    expect(calls).toEqual([{ title: alert.title, options: { body: alert.message } }]);
  });

  test('uses localized fallback strings for blank notification copy', () => {
    const { calls, NotificationCtor } = recordNotifications();

    expect(dispatchBrowserNotification({ ...alert, title: '', message: '' }, 'zh', 'granted', NotificationCtor)).toBe(true);
    expect(calls).toEqual([{ title: '等待人工裁决', options: { body: '运行正在等待人工裁决。' } }]);
  });

  test.each(['denied', 'default', 'unsupported'] as const)('skips the constructor with %s permission', (permission) => {
    const { calls, NotificationCtor } = recordNotifications();

    expect(dispatchBrowserNotification(alert, 'en', permission, NotificationCtor)).toBe(false);
    expect(calls).toEqual([]);
  });

  test('returns false when notifications are unavailable or the constructor rejects', () => {
    class BlockedNotification {
      constructor() {
        throw new Error('Notifications blocked');
      }
    }
    expect(dispatchBrowserNotification(alert, 'en', 'granted')).toBe(false);
    expect(dispatchBrowserNotification(alert, 'en', 'granted', BlockedNotification as unknown as typeof Notification)).toBe(false);
  });
});

describe('playAttentionChime', () => {
  function recordAudio() {
    const contexts: RecordingAudioContext[] = [];
    class RecordingAudioContext {
      readonly currentTime = 2;
      readonly destination = {};
      createOscillator = vi.fn(() => ({
        type: 'sine' as OscillatorType,
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      }));
      createGain = vi.fn(() => ({
        gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      }));
      close = vi.fn(async () => {});

      constructor() {
        contexts.push(this);
      }
    }
    return { contexts, AudioCtor: RecordingAudioContext as unknown as typeof AudioContext };
  }

  test('schedules two sequential tones at the stored theme volume', () => {
    const { contexts, AudioCtor } = recordAudio();
    const stored = new Map([[SOUND_ENABLED_STORAGE_KEY, 'true'], [SOUND_VOLUME_STORAGE_KEY, '0.5']]);
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => stored.get(key) ?? null } });
    try {
      expect(playAttentionChime('waiting_human', readStoredSoundEnabled(), readStoredSoundVolume(), AudioCtor)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    const [context] = contexts;
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    expect(context.createGain).toHaveBeenCalledTimes(2);

    const [first, second] = context.createOscillator.mock.results.map(({ value }) => value);
    expect(first.type).toBe('sine');
    expect(second.type).toBe('triangle');
    expect(first.start).toHaveBeenCalledWith(context.currentTime);
    expect(second.start.mock.calls[0][0]).toBeGreaterThan(first.stop.mock.calls[0][0]);

    for (const { value: gain } of context.createGain.mock.results) {
      const ramps = gain.gain.linearRampToValueAtTime.mock.calls;
      expect(ramps[0][0]).toBeCloseTo(0.08);
      expect(ramps[1][0]).toBe(0);
    }

    second.onended?.();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test.each([
    [false, 0.5],
    [true, 0],
    [true, -0.5],
  ])('skips audio when enabled is %s and volume is %s', (enabled, volume) => {
    const { contexts, AudioCtor } = recordAudio();

    expect(playAttentionChime('waiting_human', enabled, volume, AudioCtor)).toBe(false);
    expect(contexts).toEqual([]);
  });

  test('returns false when audio is unavailable or the constructor fails', () => {
    class BlockedAudioContext {
      constructor() {
        throw new Error('Audio unavailable');
      }
    }
    expect(playAttentionChime('waiting_human', true, 0.5)).toBe(false);
    expect(playAttentionChime('waiting_human', true, 0.5, BlockedAudioContext as unknown as typeof AudioContext)).toBe(false);
  });
});
