import { describe, expect, test } from 'vitest';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatReportedUsd, formatTokenCount, formatUsd, usageCoverage } from './billingFormat';

describe('cost that may not have been reported', () => {
  test('a missing cost reads "Not reported", while a reported zero stays a real amount', () => {
    expect(MESSAGES.en.inspector.billingNotReported).toBe('Not reported');
    expect(MESSAGES.zh.inspector.billingNotReported).toBe('未上报');
    expect(formatReportedUsd(null, 'en')).toBe('Not reported');
    expect(formatReportedUsd(undefined, 'zh')).toBe('未上报');
    expect(formatReportedUsd(Number.NaN, 'en')).toBe('Not reported');
    expect(formatReportedUsd(0, 'en')).toBe('$0.0000');
    expect(formatReportedUsd(0.0125, 'zh')).toBe('$0.0125');
  });

  test('a total states how many calls reported usage', () => {
    expect(usageCoverage({ reported_calls: 9, total_calls: 12 }, 'en')).toBe('9 of 12 calls reported usage');
    expect(usageCoverage({ reported_calls: 9, total_calls: 12 }, 'zh')).toBe('12 次调用中 9 次上报了用量');
    expect(usageCoverage({ reported_calls: 0, total_calls: 3 }, 'en')).toBe('0 of 3 calls reported usage');
    expect(usageCoverage({ reported_calls: 0, total_calls: 0 }, 'en')).toBeNull();
    expect(usageCoverage({}, 'en')).toBeNull();
    expect(usageCoverage(null, 'en')).toBeNull();
  });
});

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
