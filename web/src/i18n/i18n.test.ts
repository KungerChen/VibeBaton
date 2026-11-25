import { describe, expect, test } from 'vitest';
import claudeOnlyPreset from '../../../presets/claude_only_3tier.baton.json';
import codexOnlyPreset from '../../../presets/codex_only_3tier.baton.json';
import deepseekBulkPreset from '../../../presets/deepseek_bulk_factory.baton.json';
import { EMBEDDED_PRESETS, flagship_4tier } from '../data/presets';
import { STAGE1_REPLAY_TRACE, STAGE1_REPLAY_TRACE_ZH } from '../data/stage1Replay';
import { readStoredLocale } from './index';
import { MESSAGES } from './messages';
import { EN_TO_ZH_PRESET_TEXT, formatProviderDisplay, translateHandle, translatePresetText, translateRole } from './presets';

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN_PATTERN = /\p{Script=Han}/u;
const OPENCODE_PATTERN = /opencode/i;
const CONDESCENDING_PATTERN = /小白|菜鸟|傻瓜|笨蛋|noob|dummy/i;
const QUICK_START_IDENTIFIERS = /^MESSAGES\.zh\.quickStart\.(?:legendTiers\[\d+\]\.key|legendEdges\[\d+\]\.tone|shortcuts\[\d+\]\.keys)$/;
const PRESETS = [...EMBEDDED_PRESETS, claudeOnlyPreset, codexOnlyPreset, deepseekBulkPreset];

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

  test('both locales have the same non-empty message keys', () => {
    const en = collectStrings(MESSAGES.en);
    const zh = collectStrings(MESSAGES.zh);
    expect(zh.map(({ path }) => path).sort()).toEqual(en.map(({ path }) => path).sort());

    for (const [locale, entries] of Object.entries({ en, zh })) {
      for (const { path, text } of entries) {
        expect(text.trim(), `Empty message at ${locale}.${path}`).not.toBe('');
        expect(text, `Unexpected provider name at ${locale}.${path}`).not.toMatch(OPENCODE_PATTERN);
      }
    }
  });

  test('Chinese labels and copy contain Han characters', () => {
    for (const { path, text } of collectStrings(MESSAGES.zh, 'MESSAGES.zh')) {
      if (QUICK_START_IDENTIFIERS.test(path)) continue;
      expect(text, `Missing Chinese text at ${path}`).toMatch(HAN_PATTERN);
    }
  });

  test('pricing messages use the Studio titles, sync actions, and source labels', () => {
    expect(MESSAGES.en.pricing).toMatchObject({
      title: 'API Pricing',
      syncButton: 'Sync Official Prices',
      unit: 'USD / 1M tokens',
      sourceCustom: 'Custom',
      sourceOfficialCache: 'Official Cache',
      sourceBuiltin: 'Built-in',
    });
    expect(MESSAGES.zh.pricing).toMatchObject({
      title: '模型单价',
      syncButton: '立即同步官方价',
      sourceCustom: '自定义',
      sourceOfficialCache: '官方缓存',
      sourceBuiltin: '内置官方价',
    });
  });

  test('Stage 3 messages preserve credential identifiers and interpolate readiness values', () => {
    for (const [locale, messages] of Object.entries(MESSAGES)) {
      expect(Object.keys(messages.credentials.keyLabels).sort(), locale).toEqual([
        'ANTHROPIC_API_KEY',
        'DEEPSEEK_API_KEY',
        'GEMINI_API_KEY',
        'OPENAI_API_KEY',
        'OPENCODE_API_KEY',
      ]);
      expect(messages.credentials.keyLabels.DEEPSEEK_API_KEY, locale).toContain('DSH');
      expect(messages.credentials.keyLabels.OPENCODE_API_KEY, locale).toContain('DSH');
      expect(messages.nodeReadiness.latency(125), locale).toContain('125');
      expect(messages.wizard.readinessScore(85), locale).toContain('85/100');
      expect(messages.wizard.warnings.ambiguityMarker('TODO'), locale).toContain('TODO');
    }
  });

  test('English messages, canonical presets, and default Stage 1 trace contain zero CJK characters', () => {
    for (const { path, text } of collectStrings(MESSAGES.en, 'MESSAGES.en')) {
      expect(text, `Unexpected CJK at ${path}`).not.toMatch(CJK_PATTERN);
    }

    for (const preset of PRESETS) {
      for (const { path, text } of collectStrings(preset, preset.id)) {
        expect(text, `Unexpected CJK at ${path}`).not.toMatch(CJK_PATTERN);
      }
    }

    for (const event of STAGE1_REPLAY_TRACE) {
      expect(event.message, `Unexpected CJK in Stage 1 seq=${event.seq}`).not.toMatch(CJK_PATTERN);
    }
  });

  test('translates all built-in preset names, descriptions, and node labels to Chinese while preserving custom text', () => {
    for (const preset of PRESETS) {
      const texts = [preset.name, ...preset.nodes.map((node) => node.label)];
      if (preset.description !== undefined) {
        texts.push(preset.description);
      }
      for (const text of texts) {
        const en = translatePresetText(text, 'en');
        const zh = translatePresetText(text, 'zh');
        expect(zh, text).toMatch(HAN_PATTERN);
        expect(zh, text).toBe(EN_TO_ZH_PRESET_TEXT[en]);
        if (Object.hasOwn(EN_TO_ZH_PRESET_TEXT, text)) {
          expect(en, text).toBe(text);
        }
      }
    }

    expect(translatePresetText('Custom Build Step', 'zh')).toBe('Custom Build Step');
    expect(translateRole('critical_executor', 'zh')).toMatch(HAN_PATTERN);
    expect(translateRole('critical_executor', 'en')).not.toMatch(CJK_PATTERN);
    expect(translateHandle('minor_fix', 'zh')).toMatch(HAN_PATTERN);
    expect(translateHandle('minor_fix', 'en')).toBe('minor_fix');
  });

  test('uses DSH in UI labels while preserving the stored provider ID', () => {
    expect(formatProviderDisplay('dsh_opencode')).toBe('DSH');
    expect(formatProviderDisplay('dsh_deepseek')).toBe('DSH');
    expect(formatProviderDisplay('claude_sub')).toBe('claude_sub');

    for (const [en, zh] of Object.entries(EN_TO_ZH_PRESET_TEXT)) {
      expect(en.trim()).not.toBe('');
      expect(en).not.toMatch(CJK_PATTERN);
      expect(zh, en).toMatch(HAN_PATTERN);
      expect(en).not.toMatch(OPENCODE_PATTERN);
      expect(zh, en).not.toMatch(OPENCODE_PATTERN);
    }

    expect(translatePresetText(deepseekBulkPreset.name, 'en')).toBe('DSH Bulk Factory');
    expect(translatePresetText(deepseekBulkPreset.name, 'zh')).toBe('DSH 批量工厂');
    for (const [locale, messages] of Object.entries(MESSAGES)) {
      expect(messages.quickStart.steps.tryStarterDesc, locale).toContain('DSH');
      expect(messages.tutorialDiagrams.l3Workers, locale).toContain('DSH');
    }
    for (const locale of ['en', 'zh'] as const) {
      expect(translatePresetText(deepseekBulkPreset.description, locale)).toContain('DSH');
      for (const node of deepseekBulkPreset.nodes) {
        expect(translatePresetText(node.label, locale), node.id).toContain('DSH');
      }
    }

    for (const preset of PRESETS) {
      expect(preset.name).not.toMatch(OPENCODE_PATTERN);
      expect(translatePresetText(preset.name, 'zh')).not.toMatch(OPENCODE_PATTERN);
      expect(preset.description ?? '').not.toMatch(OPENCODE_PATTERN);
      expect(translatePresetText(preset.description ?? '', 'zh')).not.toMatch(OPENCODE_PATTERN);
      for (const item of preset.recommended_for ?? []) {
        expect(item).not.toMatch(OPENCODE_PATTERN);
      }
      for (const node of preset.nodes) {
        expect(node.label).not.toMatch(OPENCODE_PATTERN);
        expect(translatePresetText(node.label, 'zh')).not.toMatch(OPENCODE_PATTERN);
      }
    }

    for (const event of [...STAGE1_REPLAY_TRACE, ...STAGE1_REPLAY_TRACE_ZH]) {
      expect(event.message).not.toMatch(OPENCODE_PATTERN);
    }

    const bulkNode = flagship_4tier.nodes.find((node) => node.id === 'l3_bulk');
    expect(bulkNode?.config?.provider).toBe('dsh_opencode');
    expect(bulkNode?.config?.model).toBe('deepseek-v4.1-flash@max');
  });

  test.each(['guided', 'glossary'] as const)('%s namespace has EN/ZH parity, clean English, Han Chinese, and respectful copy', (namespace) => {
    const en = collectStrings(MESSAGES.en[namespace], namespace);
    const zh = collectStrings(MESSAGES.zh[namespace], namespace);
    expect(en.length).toBeGreaterThan(0);
    expect(zh.map(({ path }) => path).sort()).toEqual(en.map(({ path }) => path).sort());

    for (const { path, text } of en) {
      expect(text.trim(), `Empty message at en.${path}`).not.toBe('');
      expect(text, `Unexpected CJK at en.${path}`).not.toMatch(CJK_PATTERN);
      expect(text, `Unexpected provider name at en.${path}`).not.toMatch(OPENCODE_PATTERN);
      expect(text, `Condescending wording at en.${path}`).not.toMatch(CONDESCENDING_PATTERN);
    }
    for (const { path, text } of zh) {
      expect(text, `Missing Chinese text at zh.${path}`).toMatch(HAN_PATTERN);
      expect(text, `Unexpected provider name at zh.${path}`).not.toMatch(OPENCODE_PATTERN);
      expect(text, `Condescending wording at zh.${path}`).not.toMatch(CONDESCENDING_PATTERN);
    }
  });

  test('guided messages expose the Guided/Pro labels and four steps in both locales', () => {
    expect(MESSAGES.en.guided.mode).toEqual({ guided: 'Guided', pro: 'Pro' });
    expect(MESSAGES.zh.guided.mode).toEqual({ guided: '引导模式', pro: '专业模式' });
    expect(MESSAGES.en.guided.steps).toHaveLength(4);
    expect(MESSAGES.zh.guided.steps).toHaveLength(4);
  });

  test('no message in either locale uses condescending wording', () => {
    for (const { path, text } of collectStrings(MESSAGES, 'MESSAGES')) {
      expect(text, `Condescending wording at ${path}`).not.toMatch(CONDESCENDING_PATTERN);
    }
  });

  test('localizes the legacy bulk preset title and preserves custom recipe text', () => {
    const legacyTitle = ['DeepSeek', 'API Bulk Factory'].join(' ');
    const customTitle = ['Direct DeepSeek', 'API Migration'].join(' ');
    expect(translatePresetText(legacyTitle, 'en')).toBe('DSH Bulk Factory');
    expect(translatePresetText(legacyTitle, 'zh')).toBe('DSH 批量工厂');
    expect(translatePresetText(customTitle, 'en')).toBe(customTitle);
    expect(translatePresetText(customTitle, 'zh')).toBe(customTitle);
  });
});
