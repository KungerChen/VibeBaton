import { MESSAGES, type Locale } from '../../i18n/messages';
import type { BillingTelemetry } from '../../types/graph';

const missingValue = '—';

/** A billed amount, or "Not reported" when no call reported a cost; a reported zero stays an amount. */
export function formatReportedUsd(value: number | null | undefined, locale: Locale): string {
  return value == null || !Number.isFinite(value) ? MESSAGES[locale].inspector.billingNotReported : formatUsd(value, locale);
}

/** "9 of 12 calls reported usage" for a total, or null while the telemetry counts no calls. */
export function usageCoverage(
  billing: Pick<BillingTelemetry, 'reported_calls' | 'total_calls'> | null | undefined,
  locale: Locale,
): string | null {
  const total = billing?.total_calls;
  const reported = billing?.reported_calls;
  return typeof total === 'number' && total > 0 && typeof reported === 'number'
    ? MESSAGES[locale].inspector.billingCoverage(reported, total) : null;
}

export function formatUsd(value: number | null | undefined, locale: Locale): string {
  if (value == null || !Number.isFinite(value)) return missingValue;
  const fractionDigits = Math.abs(value) < 1 ? 4 : 2;
  return value.toLocaleString(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function formatTokenCount(n: number | undefined, locale: Locale): string {
  if (n == null || !Number.isFinite(n)) return missingValue;
  if (Math.abs(n) >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${millions.toLocaleString(locale, { maximumFractionDigits: 2 })}M`;
  }
  return n.toLocaleString(locale, { maximumFractionDigits: 0 });
}
