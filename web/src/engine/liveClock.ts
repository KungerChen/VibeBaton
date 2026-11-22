import { useEffect, useState } from 'react';
import type { Locale } from '../i18n/messages';

// The backend counts PLANNING and RUNNING runs. The Studio RFC also accepts stage-level statuses.
export const ACTIVE_RUN_STATUSES = ['PLANNING', 'RUNNING', 'IN_PROGRESS', 'REVIEWING', 'GATE_CHECKING'] as const;

export function isRunStatusActive(status: unknown): boolean {
  return ACTIVE_RUN_STATUSES.some((activeStatus) => activeStatus === status);
}

export function computeLiveSeconds(
  baseSec: number,
  startedAt: number | null | undefined,
  isActive: boolean | undefined,
  nowEpochSec: number,
): number {
  if (!isActive || startedAt == null || !Number.isFinite(startedAt)) return baseSec;
  return baseSec + Math.max(0, nowEpochSec - startedAt);
}

export function computeClockSkewSec(
  serverNow: number | null | undefined,
  clientNowSec = Date.now() / 1000,
): number {
  if (serverNow == null || !Number.isFinite(serverNow)) return 0;
  return serverNow - clientNowSec;
}

function safeDurationSec(sec: number): number {
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

function splitMinutes(totalMinutes: number) {
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

export function formatLiveDuration(sec: number, locale: Locale): string {
  const totalSeconds = Math.floor(safeDurationSec(sec));
  if (totalSeconds < 60) return locale === 'en' ? `${totalSeconds}s` : `${totalSeconds}秒`;

  const { hours, minutes } = splitMinutes(Math.floor(totalSeconds / 60));
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  if (hours === 0) {
    return locale === 'en' ? `${minutes}m ${seconds}s` : `${minutes}分${seconds}秒`;
  }
  const paddedMinutes = String(minutes).padStart(2, '0');
  return locale === 'en'
    ? `${hours}h ${paddedMinutes}m ${seconds}s`
    : `${hours}小时${paddedMinutes}分${seconds}秒`;
}

/** Format a snapshot duration, with seconds shown throughout for live timings. */
export function formatDurationSec(sec: number, locale: Locale, live = false): string {
  if (live) return formatLiveDuration(sec, locale);

  const safe = safeDurationSec(sec);
  if (safe === 0) return locale === 'en' ? '0s' : '0秒';
  if (safe < 60) return locale === 'en' ? `${safe.toFixed(1)}s` : `${safe.toFixed(1)}秒`;

  if (safe < 3600) {
    const roundedSeconds = Math.round(safe);
    const minutes = Math.floor(roundedSeconds / 60);
    const seconds = roundedSeconds % 60;
    if (minutes < 60) {
      return locale === 'en' ? `${minutes}m ${seconds}s` : `${minutes}分${seconds}秒`;
    }
  }

  const { hours, minutes } = splitMinutes(Math.round(safe / 60));
  return locale === 'en' ? `${hours}h ${minutes}m` : `${hours}时${minutes}分`;
}

function sampleClock(serverNow: number | null | undefined) {
  const clientNowSec = Date.now() / 1000;
  return { clientNowSec, skewSec: computeClockSkewSec(serverNow, clientNowSec) };
}

export function useLiveClock(active: boolean, serverNow?: number | null): number {
  const [clock, setClock] = useState(() => sampleClock(serverNow));

  useEffect(() => {
    setClock(sampleClock(serverNow));
  }, [serverNow]);

  useEffect(() => {
    if (active !== true) return;

    function tick() {
      const clientNowSec = Date.now() / 1000;
      setClock((previous) => (
        previous.clientNowSec === clientNowSec ? previous : { ...previous, clientNowSec }
      ));
    }

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [active]);

  return clock.clientNowSec + clock.skewSec;
}
