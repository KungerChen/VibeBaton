import { describe, expect, test } from 'vitest';
import type { RfcReadinessResult } from '../../types/graph';
import { decideRfcSkip } from './launchWizard';

const RFC_WITH_WARNINGS: RfcReadinessResult = {
  score: 65,
  safe_for_overnight: false,
  missing_sections: [],
  warnings: ['Goal is shorter than 40 characters.'],
  detected_commands: [],
};

describe('Skip Brainstorm', () => {
  test('advances on the current RFC when all sections exist', () => {
    expect(decideRfcSkip(RFC_WITH_WARNINGS)).toStrictEqual({ kind: 'advance' });
  });

  test('requires confirmation with the exact missing sections returned by readiness', () => {
    const missingSections = ['constraints', 'acceptance'];
    const readiness = { ...RFC_WITH_WARNINGS, missing_sections: missingSections };

    expect(decideRfcSkip(readiness)).toStrictEqual({ kind: 'confirm', missingSections });
  });
});
