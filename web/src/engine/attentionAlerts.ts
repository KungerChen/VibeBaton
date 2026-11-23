import { ATTENTION_TITLE_KEYS, MESSAGES, type Locale } from '../i18n/messages';
import { DEFAULT_SOUND_VOLUME } from '../liquid-theme/liquidAudio';
import type { AttentionCategory, LiveRunSnapshot, RunAttentionState } from '../types/graph';

const LEGACY_RUN_ATTENTION = new Map<string, Pick<RunAttentionState, 'category' | 'severity' | 'action_hint'>>([
  ['WAITING_HUMAN', {
    category: 'waiting_human',
    severity: 'warning',
    action_hint: 'Review and resolve the blocker in Studio.',
  }],
  ['READY_FOR_FINAL_GATE', {
    category: 'ready_for_final_gate',
    severity: 'info',
    action_hint: 'Open the battle report and review the L0 final gate.',
  }],
  ['FAILED', {
    category: 'failed',
    severity: 'error',
    action_hint: 'Inspect the run events in Studio.',
  }],
  ['PAUSED', {
    category: 'paused',
    severity: 'warning',
    action_hint: 'Resume the run in Studio when ready.',
  }],
]);

const CHIME_FREQUENCIES: Record<AttentionCategory, readonly [number, number]> = {
  waiting_human: [523, 659],
  ready_for_final_gate: [659, 880],
  failed: [440, 330],
  paused: [523, 392],
  long_cooldown: [392, 523],
};

export function deriveAttentionAlert(snapshot: LiveRunSnapshot | null): RunAttentionState | null {
  const attention = snapshot?.telemetry?.attention;
  if (attention) return attention;

  const run = snapshot?.run;
  if (!run || typeof run.status !== 'string') return null;
  const legacy = LEGACY_RUN_ATTENTION.get(run.status);
  if (!legacy) return null;

  const copy = MESSAGES.en.attention;
  const prompt = legacy.category === 'waiting_human' && typeof run.human_prompt === 'string'
    ? run.human_prompt.trim()
    : '';
  const summary = typeof run.summary === 'string' ? run.summary.trim() : '';
  const timestamp = run.updated_at ?? run.created_at;
  return {
    ...legacy,
    title: copy[ATTENTION_TITLE_KEYS[legacy.category]],
    message: prompt || summary || copy.fallbackDetails[legacy.category],
    milestone_id: null,
    task_id: null,
    created_at: typeof timestamp === 'string' || typeof timestamp === 'number' ? timestamp : null,
  };
}

export function buildAlertFingerprint(
  runId: string | null | undefined,
  alert: RunAttentionState | null,
): string | null {
  if (!runId || !alert) return null;
  const { category, milestone_id, task_id, created_at } = alert;
  return `${runId}|${category}|${milestone_id ?? ''}|${task_id ?? ''}|${created_at ?? ''}`;
}

function resolveTitle(alert: RunAttentionState, locale: Locale): string {
  return alert.title.trim() || MESSAGES[locale].attention[ATTENTION_TITLE_KEYS[alert.category]];
}

export function formatAttentionDocumentTitle(
  baseTitle: string,
  alert: RunAttentionState | null,
  locale: Locale,
  tickOdd: boolean,
): string {
  if (!alert) return baseTitle;
  const prefix = MESSAGES[locale].attention.docTitlePrefix;
  return tickOdd
    ? `${prefix}${resolveTitle(alert, locale)}] · ${baseTitle}`
    : `${prefix.trimEnd()}] · ${baseTitle}`;
}

export function dispatchBrowserNotification(
  alert: RunAttentionState,
  locale: Locale,
  permission: NotificationPermission | 'unsupported',
  NotificationCtor?: typeof Notification,
): boolean {
  if (permission !== 'granted') return false;
  try {
    const Ctor = NotificationCtor ?? globalThis.Notification;
    if (!Ctor) return false;
    new Ctor(resolveTitle(alert, locale), {
      body: alert.message.trim() || MESSAGES[locale].attention.fallbackDetails[alert.category],
    });
    return true;
  } catch {
    return false;
  }
}

async function closeAudioContext(context: AudioContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // The host may have already closed the context.
  }
}

/** Pass the theme sound preferences or the values from readStoredSoundEnabled/readStoredSoundVolume. */
export function playAttentionChime(
  category: AttentionCategory,
  enabled: boolean,
  volume: number,
  audioCtor?: typeof AudioContext,
): boolean {
  if (!enabled || volume <= 0) return false;

  let context: AudioContext | undefined;
  try {
    const Ctor = audioCtor ?? globalThis.AudioContext;
    if (!Ctor) return false;
    const audio = new Ctor();
    context = audio;
    const now = audio.currentTime;
    const duration = 0.14;
    const gap = 0.03;
    const peak = 0.16 * Math.min(1, Number.isFinite(volume) ? volume : DEFAULT_SOUND_VOLUME);
    const frequencies = CHIME_FREQUENCIES[category];

    for (const [index, frequency] of frequencies.entries()) {
      const start = now + index * (duration + gap);
      const end = start + duration;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = index === 0 ? 'sine' : 'triangle';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.015);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      if (index === frequencies.length - 1) {
        oscillator.onended = () => { void closeAudioContext(audio); };
      }
      oscillator.start(start);
      oscillator.stop(end);
    }

    if (audio.state === 'suspended') {
      void audio.resume().catch(() => closeAudioContext(audio));
    }
    return true;
  } catch {
    if (context) void closeAudioContext(context);
    return false;
  }
}
