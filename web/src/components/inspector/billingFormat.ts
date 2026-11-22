import type { Locale } from '../../i18n/messages';

const missingValue = '—';

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
