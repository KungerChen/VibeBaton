import { describe, expect, test } from 'vitest';
import { EMBEDDED_PRESETS } from '../data/presets';
import { STAGE1_REPLAY_TRACE } from '../data/stage1Replay';
import { readStoredLocale } from './index';
import { MESSAGES } from './messages';
import { translateHandle, translatePresetText, translateRole } from './presets';

const CJK_PATTERN = /[\u4e00-\u9fff]/;

function collectStrings(value: unknown, path = 'root', out: { path: string; text: string }[] = []) {
  if (typeof value === 'string') {
    out.push({ path, text: value });
    return out;
  }
  if (typeof value === 'function') {
    const sample = value(2, 3);
    if (typeof sample === 'string') out.push({ path: `${path}()`, text: sample });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      collectStrings(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

describe('i18n guarantees', () => {
  test('defaults to pure English when no stored locale exists', () => {
    expect(readStoredLocale()).toBe('en');
  });

  test('English messages, canonical presets, and default Stage 1 trace contain zero CJK characters', () => {
    for (const { path, text } of collectStrings(MESSAGES.en, 'MESSAGES.en')) {
      expect(text, `Unexpected CJK at ${path}`).not.toMatch(CJK_PATTERN);
    }

    for (const preset of EMBEDDED_PRESETS) {
      for (const { path, text } of collectStrings(preset, preset.id)) {
        expect(text, `Unexpected CJK at ${path}`).not.toMatch(CJK_PATTERN);
      }
    }

    for (const event of STAGE1_REPLAY_TRACE) {
      expect(event.message, `Unexpected CJK in Stage 1 seq=${event.seq}`).not.toMatch(CJK_PATTERN);
    }
  });

  test('translates all built-in preset names, descriptions, and node labels to Chinese while preserving custom text', () => {
    for (const preset of EMBEDDED_PRESETS) {
      const zhName = translatePresetText(preset.name, 'zh');
      expect(zhName, preset.id).toMatch(CJK_PATTERN);

      if (preset.description) {
        expect(translatePresetText(preset.description, 'zh'), `${preset.id}.description`).toMatch(CJK_PATTERN);
      }

      for (const node of preset.nodes) {
        const zhLabel = translatePresetText(node.label, 'zh');
        expect(zhLabel, `${preset.id}.${node.id}`).toMatch(CJK_PATTERN);
        expect(translatePresetText(node.label, 'en')).toBe(node.label);
      }
    }

    expect(translatePresetText('Custom Build Step', 'zh')).toBe('Custom Build Step');
    expect(translateRole('critical_executor', 'zh')).toMatch(CJK_PATTERN);
    expect(translateRole('critical_executor', 'en')).not.toMatch(CJK_PATTERN);
    expect(translateHandle('minor_fix', 'zh')).toMatch(CJK_PATTERN);
    expect(translateHandle('minor_fix', 'en')).toBe('minor_fix');
  });
});
