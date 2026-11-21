import { describe, expect, test } from 'vitest';
import { EDGE_TONE_COLORS, edgeSemanticTone } from './BatonEdge';

describe('edgeSemanticTone', () => {
  test.each([
    ['pass', 'normal'],
    ['approve', 'normal'],
    ['out', 'normal'],
    ['dag', 'normal'],
    ['rfc', 'normal'],
    ['critical', 'normal'],
    ['routine', 'normal'],
    [undefined, 'normal'],
    [null, 'normal'],
    ['fail', 'retry'],
    ['minor_fix', 'retry'],
    ['reject', 'retry'],
    ['escalate', 'escalate'],
  ] as const)('maps handle %s to %s', (handle, expected) => {
    expect(edgeSemanticTone(handle)).toBe(expected);
  });

  test('defines distinct colors for normal, retry, and escalate tones', () => {
    const activeColors = new Set([
      EDGE_TONE_COLORS.normal.active,
      EDGE_TONE_COLORS.retry.active,
      EDGE_TONE_COLORS.escalate.active,
    ]);
    const traversedColors = new Set([
      EDGE_TONE_COLORS.normal.traversed,
      EDGE_TONE_COLORS.retry.traversed,
      EDGE_TONE_COLORS.escalate.traversed,
    ]);

    expect(activeColors.size).toBe(3);
    expect(traversedColors.size).toBe(3);
  });
});
