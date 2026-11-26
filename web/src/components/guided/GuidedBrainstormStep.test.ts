import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { BlueprintCard, BrainstormTurnResult, ChecklistItem, RecommendedLineup } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import {
  appendTurn,
  applyExample,
  BRAINSTORM_SCENARIOS,
  BrainstormTurn,
  brainstormStorageKey,
  canLaunch,
  checklistProgress,
  clearBrainstorm,
  confirmAndStart,
  editPrefill,
  FEATURED_SCENARIO_IDS,
  GuidedBrainstormStep,
  loadBrainstorm,
  loadTypewriterPref,
  normalizeChecklist,
  notReadyReason,
  retryBrainstormTurn,
  retryTranscript,
  saveBrainstorm,
  saveTypewriterPref,
  sendBrainstormTurn,
  shouldSubmitOnKey,
  typewriterFrames,
  TYPEWRITER_MAX_MS,
  TYPEWRITER_MIN_MS,
  waitingPhase,
  type GuidedBrainstormApi,
} from './GuidedBrainstormStep';

const LINEUP: RecommendedLineup = {
  ready: true, roles: { planner: 'claude_sub' }, source: 'cli', notes_en: 'OK', notes_zh: 'OK zh',
};

function card(score: number, ready: boolean): BlueprintCard {
  return {
    title: 'Todo app',
    summary: 'A small todo app.',
    deliverables: ['web/index.html'],
    touched_areas: ['web/'],
    verification_plan: ['npm test'],
    readiness_score: score,
    ready_to_launch: ready,
  };
}

function checklist(statuses: Record<string, ChecklistItem['status']> = {}): ChecklistItem[] {
  return (['what', 'who', 'scope', 'limits', 'done'] as const).map((id) => {
    const status = statuses[id] ?? 'open';
    return { id, status, value: status === 'open' ? '' : `${id} value` };
  });
}

function turnResult(reply: string, ready: boolean, extra: Partial<BrainstormTurnResult> = {}): BrainstormTurnResult {
  return {
    reply,
    rfc_markdown: `# Todo\n\n${reply}`,
    blueprint: card(ready ? 92 : 40, ready),
    provider_used: null,
    offline: true,
    guide: { question: 'Who is it for?', options: ['Me', 'My team'], checklist: checklist({ what: 'clear' }) },
    error: null,
    ...extra,
  };
}

function fakeApi(replies: BrainstormTurnResult[], calls: string[] = []) {
  const queue = [...replies];
  return {
    calls,
    brainstormChat: vi.fn(async () => {
      calls.push('chat');
      return queue.shift()!;
    }),
    brainstormConfirm: vi.fn(async () => {
      calls.push('confirm');
      return { rfc_path: '/repo/.baton/00_RFC.md', readiness: {} as never, ready_to_launch: true };
    }),
    startRun: vi.fn(async () => {
      calls.push('start');
      return { run_id: 'run-42' };
    }),
  } satisfies GuidedBrainstormApi & { calls: string[] };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const brokenStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('full'); },
  removeItem: () => { throw new Error('blocked'); },
};

describe('pure helpers', () => {
  test('appendTurn returns a new array and leaves the input untouched', () => {
    const before = [{ role: 'user' as const, content: 'hi' }];
    const after = appendTurn(before, 'assistant', 'hello');
    expect(after).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
    expect(before).toHaveLength(1);
  });

  test('canLaunch requires ready_to_launch', () => {
    expect(canLaunch(null)).toBe(false);
    expect(canLaunch(card(95, false))).toBe(false);
    expect(canLaunch(card(95, true))).toBe(true);
  });

  test('examples fill an empty box or replace another example, never the user\'s own words', () => {
    const [first, second] = BRAINSTORM_SCENARIOS;
    expect(applyExample('', first.prompt_zh)).toBe(first.prompt_zh);
    expect(applyExample('  ', first.prompt_en)).toBe(first.prompt_en);
    expect(applyExample(first.prompt_en, second.prompt_en)).toBe(second.prompt_en);
    expect(applyExample('My own idea', second.prompt_en)).toBe('My own idea');
  });

  test('change prefill replaces an earlier change prefix and keeps the rest', () => {
    const prefixes = ['About "A", I want to change it to: ', 'About "B", I want to change it to: '];
    expect(editPrefill('', prefixes[0], prefixes)).toBe(prefixes[0]);
    expect(editPrefill(`${prefixes[0]}only admins`, prefixes[1], prefixes)).toBe(`${prefixes[1]}only admins`);
    expect(editPrefill('draft text', prefixes[1], prefixes)).toBe(`${prefixes[1]}draft text`);
  });

  test('Enter sends, Shift+Enter and IME composition do not', () => {
    expect(shouldSubmitOnKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(shouldSubmitOnKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSubmitOnKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitOnKey({ key: 'a', shiftKey: false })).toBe(false);
  });

  test('checklist is normalized to five ordered items and counted', () => {
    const items = normalizeChecklist(turnResult('x', false, {
      guide: { question: '', options: [], checklist: [{ id: 'done', status: 'assumed', value: 'Run tests' }] },
    }));
    expect(items.map((item) => item.id)).toEqual(['what', 'who', 'scope', 'limits', 'done']);
    expect(items[4]).toEqual({ id: 'done', status: 'assumed', value: 'Run tests' });
    expect(normalizeChecklist(null).every((item) => item.status === 'open')).toBe(true);
    expect(checklistProgress(checklist({ what: 'clear', who: 'clear', scope: 'assumed' }))).toEqual({
      clear: 2, assumed: 1, total: 5,
    });
  });

  test('not-ready reason names what is missing in plain words', () => {
    const labels = MESSAGES.en.guided.brainstorm;
    expect(notReadyReason(null, true, labels, ', ')).toBeNull();
    expect(notReadyReason(turnResult('x', true), true, labels, ', ')).toBeNull();
    expect(notReadyReason(turnResult('x', true), false, labels, ', ')).toBe(labels.notReadyLineup);
    expect(notReadyReason(turnResult('x', false), true, labels, ', ')).toBe(
      labels.notReadyMissing('Who it is for, How far this round goes, What must not change, How we know it is done'),
    );
    const allSettled = turnResult('x', false, {
      guide: { question: '', options: [], checklist: checklist({ what: 'clear', who: 'clear', scope: 'clear', limits: 'clear', done: 'assumed' }) },
    });
    expect(notReadyReason(allSettled, true, labels, ', ')).toBe(labels.notReadyCheck);
  });

  test('waiting copy moves from reading to drafting to slower than usual', () => {
    expect(waitingPhase(0)).toBe('understanding');
    expect(waitingPhase(4999)).toBe('understanding');
    expect(waitingPhase(5000)).toBe('drafting');
    expect(waitingPhase(44999)).toBe('drafting');
    expect(waitingPhase(45000)).toBe('slow');
  });

  test('typewriter frames grow to the full text and play in 2-4 seconds', () => {
    for (const text of ['Short reply here.', '这是一段比较短的中文回复。', 'word '.repeat(400), '长'.repeat(1000)]) {
      const { frames, intervalMs } = typewriterFrames(text);
      expect(frames[frames.length - 1]).toBe(text);
      expect(frames.length).toBeLessThanOrEqual(60);
      for (let i = 1; i < frames.length; i += 1) {
        expect(frames[i].startsWith(frames[i - 1])).toBe(true);
        expect(frames[i].length).toBeGreaterThan(frames[i - 1].length);
      }
      const total = intervalMs * frames.length;
      expect(total).toBeGreaterThanOrEqual(TYPEWRITER_MIN_MS - 60);
      expect(total).toBeLessThanOrEqual(TYPEWRITER_MAX_MS + 60);
    }
    expect(typewriterFrames('Hi')).toEqual({ frames: ['Hi'], intervalMs: 0 });
  });
});

describe('local persistence', () => {
  const saved = {
    messages: [{ role: 'user' as const, content: 'Build a todo app' }, { role: 'assistant' as const, content: 'Who is it for?' }],
    scenario: 'web_app',
    turn: turnResult('Who is it for?', false),
  };

  test('round-trips per project and clears', () => {
    const storage = memoryStorage();
    saveBrainstorm(storage, '/repo/a', saved);
    expect(loadBrainstorm(storage, '/repo/a')).toEqual(saved);
    expect(loadBrainstorm(storage, '/repo/b')).toBeNull();
    clearBrainstorm(storage, '/repo/a');
    expect(loadBrainstorm(storage, '/repo/a')).toBeNull();
  });

  test('broken data and blocked storage are ignored', () => {
    const key = brainstormStorageKey('/repo');
    for (const raw of ['{not json', '[]', '{"messages": "x"}', '{"messages": [{"role": "system", "content": "x"}]}', '{"messages": []}']) {
      expect(loadBrainstorm(memoryStorage({ [key]: raw }), '/repo')).toBeNull();
    }
    const badTurn = JSON.stringify({ ...saved, turn: { reply: 'x' } });
    expect(loadBrainstorm(memoryStorage({ [key]: badTurn }), '/repo')).toEqual({ ...saved, turn: null });
    expect(loadBrainstorm(brokenStorage, '/repo')).toBeNull();
    expect(loadBrainstorm(null, '/repo')).toBeNull();
    expect(() => saveBrainstorm(brokenStorage, '/repo', saved)).not.toThrow();
    expect(() => clearBrainstorm(brokenStorage, '/repo')).not.toThrow();
  });

  test('typing effect defaults on and remembers the choice', () => {
    const storage = memoryStorage();
    expect(loadTypewriterPref(storage)).toBe(true);
    saveTypewriterPref(storage, false);
    expect(loadTypewriterPref(storage)).toBe(false);
    saveTypewriterPref(storage, true);
    expect(loadTypewriterPref(storage)).toBe(true);
    expect(loadTypewriterPref(brokenStorage)).toBe(true);
    expect(() => saveTypewriterPref(brokenStorage, false)).not.toThrow();
  });
});

describe('chat -> confirm -> start flow', () => {
  test('multi-turn transcript grows and the full history is sent each turn', async () => {
    const api = fakeApi([turnResult('What command proves it works?', false), turnResult('Ready to build.', true)]);

    const first = await sendBrainstormTurn(api, [], 'Build a todo app', 'web_app');
    expect(first.messages).toHaveLength(2);
    expect(canLaunch(first.turn.blueprint)).toBe(false);
    expect(api.brainstormChat).toHaveBeenLastCalledWith({
      messages: [{ role: 'user', content: 'Build a todo app' }], scenario: 'web_app',
    });

    const second = await sendBrainstormTurn(api, first.messages, 'npm test', 'web_app');
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(second.messages[3].content).toBe('Ready to build.');
    expect(api.brainstormChat).toHaveBeenLastCalledWith(expect.objectContaining({ messages: first.messages.concat({ role: 'user', content: 'npm test' }) }));
    expect(canLaunch(second.turn.blueprint)).toBe(true);
  });

  test('retry resends the last user turn once and replaces the fallback reply', async () => {
    const history = [
      { role: 'user' as const, content: 'Build a todo app' },
      { role: 'assistant' as const, content: 'Offline draft.' },
    ];
    expect(retryTranscript(history)).toEqual([history[0]]);
    expect(retryTranscript([history[0]])).toEqual([history[0]]);
    expect(retryTranscript([])).toBeNull();
    expect(retryTranscript([history[1]])).toBeNull();

    const api = fakeApi([turnResult('Live reply.', false)]);
    const result = await retryBrainstormTurn(api, history, 'web_app', 'en');
    expect(api.brainstormChat).toHaveBeenLastCalledWith({
      messages: [history[0]], scenario: 'web_app', locale: 'en',
    });
    expect(result.messages).toEqual([history[0], { role: 'assistant', content: 'Live reply.' }]);
    await expect(retryBrainstormTurn(api, [], null)).rejects.toThrow();
  });

  test('the lineup L0 model choice is sent with each turn', async () => {
    const api = fakeApi([turnResult('ok', false), turnResult('ok', false)]);
    const lineup: RecommendedLineup = {
      ...LINEUP,
      roles: { brainstorm_and_final_gate: 'codex_sub', bulk_worker: 'dsh_opencode' },
      model_overrides: { brainstorm_and_final_gate: 'codex_sub:gpt-6.2-astra@xhigh', bulk_worker: 'dsh_opencode:x@max' },
    };
    await sendBrainstormTurn(api, [], 'Add CSV export', null, 'en', lineup);
    expect(api.brainstormChat).toHaveBeenLastCalledWith({
      messages: [{ role: 'user', content: 'Add CSV export' }],
      scenario: null,
      locale: 'en',
      model_overrides: { brainstorm_and_final_gate: 'codex_sub:gpt-6.2-astra@xhigh' },
    });

    // Without an explicit model the L0 provider is sent so the server picks that provider's configured model.
    await sendBrainstormTurn(api, [], 'Add CSV export', null, 'en', { ...lineup, model_overrides: undefined });
    expect(api.brainstormChat).toHaveBeenLastCalledWith(expect.objectContaining({
      role_providers: { brainstorm_and_final_gate: 'codex_sub' },
    }));
  });

  test('confirm runs before start, the lineup is forwarded and the run id is returned', async () => {
    const api = fakeApi([]);
    const runId = await confirmAndStart(api, '# Todo', LINEUP);
    expect(api.calls).toEqual(['confirm', 'start']);
    expect(api.brainstormConfirm).toHaveBeenCalledWith('# Todo');
    expect(api.startRun).toHaveBeenCalledWith({
      rfc_path: '/repo/.baton/00_RFC.md',
      mode: 'overnight',
      role_providers: { planner: 'claude_sub' },
    });
    expect(runId).toBe('run-42');
  });

  test('a single-CLI host lineup moves every role onto that provider', async () => {
    const api = fakeApi([]);
    const codexOnly: RecommendedLineup = {
      ...LINEUP, roles: { tactical_planner: 'codex_sub', bulk_worker: 'codex_sub' },
    };
    await confirmAndStart(api, '# Todo', codexOnly);
    expect(api.startRun).toHaveBeenCalledWith(expect.objectContaining({
      role_providers: { tactical_planner: 'codex_sub', bulk_worker: 'codex_sub' },
    }));
  });

  test('forwards explicit model_overrides when present on the lineup', async () => {
    const api = fakeApi([]);
    const custom: RecommendedLineup = {
      ...LINEUP,
      roles: { brainstorm_and_final_gate: 'gemini_sub' },
      model_overrides: { brainstorm_and_final_gate: 'gemini_sub:gemini-4-carbon@medium' },
    };
    await confirmAndStart(api, '# Todo', custom);
    expect(api.startRun).toHaveBeenCalledWith({
      rfc_path: '/repo/.baton/00_RFC.md',
      mode: 'overnight',
      role_providers: { brainstorm_and_final_gate: 'gemini_sub' },
      model_overrides: { brainstorm_and_final_gate: 'gemini_sub:gemini-4-carbon@medium' },
    });
  });

  test('start is skipped when confirm fails', async () => {
    const api = fakeApi([]);
    api.brainstormConfirm.mockRejectedValueOnce(new Error('disk full'));
    await expect(confirmAndStart(api, '# Todo', LINEUP)).rejects.toThrow('disk full');
    expect(api.startRun).not.toHaveBeenCalled();
  });
});

describe('GuidedBrainstormStep render', () => {
  function render(locale: 'en' | 'zh'): string {
    return renderToStaticMarkup(
      createElement(GuidedBrainstormStep, { locale, lineup: LINEUP, onLaunched: () => {}, api: fakeApi([]) }),
    );
  }

  test('launch is disabled before any blueprint exists', () => {
    expect(render('en')).toMatch(/<button type="button" class="guided-brainstorm__launch" disabled="">/);
  });

  test('opens with one sentence box, a few examples and the rest folded away', () => {
    const zh = render('zh');
    expect(zh).toContain('用一句话说说你想做什么');
    expect(zh).toContain('确认蓝图并开始施工');
    expect(zh).toContain('更多灵感');
    expect(zh).toContain('<details class="guided-brainstorm__more">');
    for (const item of BRAINSTORM_SCENARIOS) expect(zh).toContain(item.title_zh);
    const featuredEnd = zh.indexOf('<details');
    for (const item of BRAINSTORM_SCENARIOS) {
      const position = zh.indexOf(item.title_zh);
      expect(position < featuredEnd).toBe(FEATURED_SCENARIO_IDS.includes(item.id));
    }
    expect(FEATURED_SCENARIO_IDS.length).toBeGreaterThanOrEqual(3);
    expect(FEATURED_SCENARIO_IDS.length).toBeLessThanOrEqual(4);
    const en = render('en');
    expect(en).toContain('Tell me in one sentence what you want to make');
    expect(en).toContain('Confirm Blueprint &amp; Start Building');
  });

  test('the blueprint shows all five checklist items as not discussed yet', () => {
    const en = render('en');
    for (const label of Object.values(MESSAGES.en.guided.brainstorm.items)) expect(en).toContain(label);
    expect(en.match(/guided-brainstorm__item--open/g)).toHaveLength(5);
    expect(en).toContain('Typing effect');
  });

  test('scenario openers are one natural sentence', () => {
    expect(BRAINSTORM_SCENARIOS.map((item) => item.id)).toEqual([
      'new_feature', 'bug_fix', 'refactor', 'add_tests', 'web_app', 'performance',
      'ui_redesign', 'dependency_upgrade', 'write_docs', 'script_or_data', 'not_sure',
    ]);
    for (const item of BRAINSTORM_SCENARIOS) {
      expect(item.prompt_en).not.toContain('\n');
      expect(item.prompt_zh).not.toContain('\n');
    }
  });

  test('blueprint copy avoids jargon and keeps English ASCII', () => {
    const jargon = /RFC|readiness|deliverable|就绪度|交付物/i;
    for (const locale of ['en', 'zh'] as const) {
      const labels = MESSAGES[locale].guided.brainstorm;
      const texts = Object.entries(labels).flatMap(([, value]) => {
        if (typeof value === 'function') return [String((value as (...args: unknown[]) => string)('x', 'y'))];
        if (typeof value === 'object') return Object.values(value as Record<string, string>);
        return [value as string];
      });
      for (const text of texts) {
        expect(text).not.toMatch(jargon);
        if (locale === 'en') expect(/^[\x20-\x7e]*$/.test(text), text).toBe(true);
      }
    }
  });

  test('renders assistant replies as formatted Markdown while keeping user turns plain text', () => {
    const assistantMarkup = renderToStaticMarkup(
      createElement(BrainstormTurn, {
        message: {
          role: 'assistant',
          content: '已理解你的**核心目标**，请运行 `pytest` 验证：\n\n- 选项一\n- 选项二',
        },
      }),
    );
    expect(assistantMarkup).toContain('<strong>核心目标</strong>');
    expect(assistantMarkup).toContain('<code>pytest</code>');
    expect(assistantMarkup).toContain('<ul><li>选项一</li><li>选项二</li></ul>');
    expect(assistantMarkup).not.toContain('**核心目标**');

    const userMarkup = renderToStaticMarkup(
      createElement(BrainstormTurn, {
        message: { role: 'user', content: '**keep raw**' },
      }),
    );
    expect(userMarkup).toContain('**keep raw**');
    expect(userMarkup).not.toContain('<strong>');
  });
});
