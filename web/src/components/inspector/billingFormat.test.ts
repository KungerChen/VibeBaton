import { describe, expect, test } from 'vitest';
import type { Locale } from '../../i18n/messages';
import { formatTokenCount, formatUsd } from './billingFormat';

describe('formatUsd', () => {
  test.each<[number | null | undefined, Locale, string]>([
    [0.0142, 'en', '$0.0142'],
    [0.0142, 'zh', '$0.0142'],
    [0, 'en', '$0.0000'],
    [0.5, 'zh', '$0.5000'],
    [0.9999, 'en', '$0.9999'],
    [1, 'en', '$1.00'],
    [12.346, 'en', '$12.35'],
    [1234.5, 'zh', '$1,234.50'],
    [null, 'en', '—'],
    [undefined, 'zh', '—'],
    [Number.NaN, 'en', '—'],
    [Number.POSITIVE_INFINITY, 'zh', '—'],
  ])('formats %s in %s as %s', (value, locale, expected) => {
    expect(formatUsd(value, locale)).toBe(expected);
  });
});

describe('formatTokenCount', () => {
  test.each<[number | undefined, Locale, string]>([
    [0, 'en', '0'],
    [999, 'en', '999'],
    [1234, 'en', '1,234'],
    [999_999, 'zh', '999,999'],
    [1_000_000, 'en', '1M'],
    [1_250_000, 'en', '1.25M'],
    [2_345_678, 'zh', '2.35M'],
    [undefined, 'en', '—'],
    [Number.NaN, 'zh', '—'],
  ])('formats %s in %s as %s', (count, locale, expected) => {
    expect(formatTokenCount(count, locale)).toBe(expected);
  });
});
