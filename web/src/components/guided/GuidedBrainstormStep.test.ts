import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type BlueprintCard, type BrainstormTurnResult, type ChecklistItem, type GuidedSession, type RecommendedLineup } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import { BUILTIN_MODEL_CATALOG } from './GuidedSetupStep';
import {
  appendTurn,
  applyExample,
  BRAINSTORM_SCENARIOS,
  BrainstormTurn,
  brainstormRequestContext,
  brainstormStorageKey,
  canLaunch,
  checklistProgress,
  clearBrainstorm,
  confirmAndStart,
  createLaunchFlight,
  editPrefill,
  FEATURED_SCENARIO_IDS,
  GuidedBrainstormStep,
  loadBrainstorm,
  loadTypewriterPref,
  normalizeChecklist,
  notReadyReason,
  retryBrainstormTurn,
  retryTranscript,
  selectBrainstormResult,
  saveBrainstorm,
  saveTypewriterPref,
  sendBrainstormTurn,
  startKeyedLaunch,
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

describe('protected online blueprint and keyed launch', () => {
  test('a retryable response keeps the prior blueprint and exposes a retry', () => {
    const previous = turnResult('Original blueprint', true, { offline: false, responding_model: 'first-model' });
    const failure = turnResult('Online request failed', false, {
      error: 'timeout', retryable: true, offline: false, responding_model: null,
    });
    const selected = selectBrainstormResult(previous, failure);
    expect(selected.turn).toBe(previous);
    expect(selected.retryError).toBe('timeout');
    expect(selectBrainstormResult(null, failure).turn).toBe(failure);
    const offline = turnResult('Offline template', false, { error: 'unavailable', offline: true });
    expect(selectBrainstormResult(null, offline).turn).toBe(offline);
  });

  test('two rapid launch attempts share a single in-flight operation', async () => {
    const flight = createLaunchFlight();
    let finish!: (value: string) => void;
    const launch = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = flight(launch);
    const second = flight(launch);
    expect(launch).toHaveBeenCalledTimes(1);
    finish('run-id');
    await expect(first).resolves.toBe('run-id');
    await expect(second).resolves.toBe('run-id');
  });

  test('persists one request ID and exact payload before two rapid clicks dispatch one start call', async () => {
    const session: GuidedSession = {
      schema_version: 1, active_stage: 'blueprint', workspace_path: '/repo', active_run_id: 'old-run',
      brainstorm: { messages: [], checklist: [], latest_rfc_draft: '# draft', selected_l0_model: null, has_online_draft: true },
      workflow: { mode: 'overnight', lineup: { roles: LINEUP.roles, model_overrides: {} }, preset: null,
        panel_enabled: false, launch_request_id: 'old-key' }, open_human_gate: null, open_drawer: null,
    };
    const calls: string[] = [];
    let resolve!: (value: { run_id: string }) => void;
    const startRun = vi.fn((_payload: Parameters<GuidedBrainstormApi['startRun']>[0]) => {
      calls.push('start'); return new Promise<{ run_id: string }>((done) => { resolve = done; });
    });
    const persistence = {
      save: vi.fn(() => { calls.push('save'); }),
      flush: vi.fn(async () => { calls.push('flush'); return session; }),
      ensureLaunchRequestId: vi.fn(async () => { calls.push('key'); return 'new-stable-key'; }),
    };
    const onPrepared = vi.fn();
    const options = { api: { startRun }, session, persistence, pending: null, draft: '# revised',
      lineup: { roles: LINEUP.roles, model_overrides: {} }, mode: 'overnight' as const, preset: null, onPrepared };
    const flight = createLaunchFlight();
    const first = flight(() => startKeyedLaunch(options));
    const second = flight(() => startKeyedLaunch(options));
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledOnce());
    expect(persistence.ensureLaunchRequestId).toHaveBeenCalledOnce();
    expect(persistence.save).toHaveBeenCalledWith({ workflow: { launch_request_id: null, guided_launch_parent: 'old-run' } });
    expect(calls.indexOf('flush')).toBeLessThan(calls.indexOf('start'));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ launch_request_id: 'new-stable-key', rfc_markdown: '# revised' }));
    expect(onPrepared).toHaveBeenCalledWith(startRun.mock.calls[0][0]);
    resolve({ run_id: 'new-run' });
    await expect(first).resolves.toBe('new-run');
    await expect(second).resolves.toBe('new-run');
  });

  test('switches requested models without changing the prior transcript and reports the actual model', async () => {
    const api = fakeApi([turnResult('First response', true, { offline: false, responding_model: 'actual-first' }),
      turnResult('Second response', true, { offline: false, responding_model: 'actual-second' })]);
    const first = await sendBrainstormTurn(api, [], 'Idea', null, 'en', undefined, { requested_l0_model: 'one:first@high' });
    const second = await sendBrainstormTurn(api, first.messages, 'Change it', null, 'en', undefined, { requested_l0_model: 'two:second@high' });
    expect(second.messages.slice(0, 2)).toEqual(first.messages);
    expect(api.brainstormChat).toHaveBeenLastCalledWith(expect.objectContaining({ requested_l0_model: 'two:second@high' }));
    expect(renderToStaticMarkup(createElement(BrainstormTurn, { message: second.messages[3],
      modelLabel: 'Responded with', respondingModel: second.turn.responding_model }))).toContain('actual-second');
  });

  test('revision requests carry the previous draft, failure details, lineup and automatic model', () => {
    const session: GuidedSession = {
      schema_version: 1, active_stage: 'blueprint', workspace_path: '/repo', active_run_id: 'run-1',
      brainstorm: { messages: [], checklist: [], latest_rfc_draft: '# prior', selected_l0_model: null, has_online_draft: true,
        replan_contexts: { 'run-1': JSON.stringify({ run_summary: 'Build failed',
          failed_tasks: [{ id: 'T1', title: 'Tests' }], last_errors: { T1: 'pytest failed' } }) } },
      workflow: { mode: 'overnight', preset: null, panel_enabled: false, launch_request_id: null,
        lineup: { roles: LINEUP.roles, model_overrides: {}, size: 'medium' } },
      open_human_gate: null, open_drawer: null,
    };
    expect(brainstormRequestContext(session, '# prior', 'Fix the tests', null, 'codex:strong@high')).toEqual({
      requested_l0_model: 'codex:strong@high',
      revision_context: { prior_rfc: '# prior', requested_changes: 'Fix the tests' },
      failure_context: 'Build failed\nT1 — Tests\nT1: pytest failed',
      previous_lineup: session.workflow.lineup,
    });
    expect(brainstormRequestContext(null, '', 'Idea', 'chosen:model', 'auto:model')).toEqual({ requested_l0_model: 'chosen:model' });
  });

  test('replays the persisted payload unchanged after an uncertain start', async () => {
    const pending = { launch_request_id: 'same-key', rfc_markdown: '# original', mode: 'panel' as const,
      lineup: { roles: { planner: 'codex_sub' }, model_overrides: {}, size: 'large' as const }, preset: 'specialist_panel' };
    const session = { active_run_id: 'parent' } as GuidedSession;
    const api = { startRun: vi.fn().mockResolvedValue({ run_id: 'recovered-run' }) };
    const persistence = { save: vi.fn(), flush: vi.fn(), ensureLaunchRequestId: vi.fn() };
    const result = await startKeyedLaunch({ api, session, persistence, pending, draft: '# changed',
      lineup: { roles: {}, model_overrides: {} }, mode: 'overnight', preset: null, onPrepared: vi.fn() });
    expect(result).toBe('recovered-run');
    expect(api.startRun).toHaveBeenCalledWith(pending);
    expect(persistence.ensureLaunchRequestId).not.toHaveBeenCalled();
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

  test('launch bar is absent before a blueprint is ready', () => {
    expect(render('en')).not.toContain('guided-launch-bar');
  });

  test('opens with one sentence box, a few examples and the rest folded away', () => {
    const zh = render('zh');
    expect(zh).toContain('用一句话说说你想做什么');
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

// The project runs Vitest in Node; this small host supports mounting the real
// component and invoking its handlers without adding a DOM dependency.
class TestNode {
  childNodes: TestNode[] = [];
  parentNode: TestNode | null = null;
  nodeValue: string | null = null;
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: TestDocument) {}
  appendChild(node: TestNode) { node.parentNode?.removeChild(node); this.childNodes.push(node); node.parentNode = this; return node; }
  removeChild(node: TestNode) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  insertBefore(node: TestNode, before: TestNode) {
    node.parentNode?.removeChild(node); this.childNodes.splice(this.childNodes.indexOf(before), 0, node); node.parentNode = this; return node;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.nodeValue ?? this.childNodes.map((child) => child.textContent).join(''); }
  set textContent(value: string) {
    this.childNodes = [];
    this.nodeValue = this.nodeType === 3 ? value : null;
    if (this.nodeType !== 3 && value) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  addEventListener() {}
  removeEventListener() {}
}

class TestElement extends TestNode {
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  value = '';
  checked = false;
  selected = false;
  disabled = false;
  multiple = false;
  constructor(tag: string, document: TestDocument) { super(1, tag.toUpperCase(), document); this.tagName = this.nodeName; }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  get options(): TestElement[] {
    return this.childNodes.flatMap((child) => child instanceof TestElement
      ? child.tagName === 'OPTION' ? [child] : child.options : []);
  }
  focus() { this.ownerDocument.activeElement = this; }
}

class TestDocument {
  nodeType = 9;
  documentElement = new TestElement('html', this);
  body = new TestElement('body', this);
  activeElement: TestElement | null = this.body;
  createElement(tag: string) { return new TestElement(tag, this); }
  createElementNS(_namespace: string, tag: string) { return this.createElement(tag); }
  createTextNode(value: string) { const node = new TestNode(3, '#text', this); node.nodeValue = value; return node; }
  addEventListener() {}
  removeEventListener() {}
}

function reactProps(node: TestNode): Record<string, unknown> {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'));
  return key ? (node as unknown as Record<string, Record<string, unknown>>)[key] : {};
}

function findNode(root: TestNode, predicate: (node: TestNode, props: Record<string, unknown>) => boolean): TestNode | undefined {
  if (predicate(root, reactProps(root))) return root;
  for (const child of root.childNodes) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

afterEach(() => vi.unstubAllGlobals());

test('mounted step preserves, restores, launches once, and replans with failure context', async () => {
  const document = new TestDocument();
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', { document, HTMLIFrameElement: class {}, matchMedia: () => ({ matches: true }),
    localStorage: memoryStorage() });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', { randomUUID: () => 'one-launch-id' });
  let session: GuidedSession = {
    schema_version: 1, active_stage: 'blueprint', workspace_path: '/repo', active_run_id: null,
    brainstorm: { messages: [], checklist: [], latest_rfc_draft: '', selected_l0_model: null, has_online_draft: false },
    workflow: { mode: null, lineup: { roles: {}, model_overrides: {} }, preset: null, panel_enabled: false, launch_request_id: null },
    open_human_gate: null, open_drawer: null,
  };
  const recommendation = { mode: 'overnight' as const, preset: null, size: 'medium' as const,
    lineup: { roles: LINEUP.roles, model_overrides: {}, size: 'medium' as const }, reason_code: 'medium_relay',
    explanation_key: 'workflow.medium_relay', fallback: false, size_changed: null,
    explanation_codes: ['medium_relay'], substitutions: [] };
  const first = turnResult('First response', true, { offline: false, provider_used: 'one', responding_model: 'first-model', recommendation });
  const failed = turnResult('Please retry', true, { ...first, reply: 'Please retry', error: 'timeout', retryable: true,
    responding_model: null, blueprint: { ...first.blueprint, title: 'Incorrect replacement' } });
  const second = turnResult('Revised response', true, { ...first, reply: 'Revised response', responding_model: 'second-model' });
  const results = [first, failed, second];
  const api = { ...fakeApi([]), brainstormChat: vi.fn(async (request: Parameters<GuidedBrainstormApi['brainstormChat']>[0]) => {
    const result = results.shift()!;
    session = { ...session, brainstorm: { ...session.brainstorm,
      messages: [...request.messages, { role: 'assistant', content: result.reply }],
      checklist: result.guide.checklist, latest_rfc_draft: result.rfc_markdown, has_online_draft: true } };
    return result;
  }) };
  const services = {
    getGuidedSession: vi.fn(async () => structuredClone(session)),
    saveGuidedSession: vi.fn(async (patch: Partial<GuidedSession>) => {
      session = { ...session, ...patch,
        brainstorm: { ...session.brainstorm, ...patch.brainstorm },
        workflow: { ...session.workflow, ...patch.workflow,
          lineup: { ...session.workflow.lineup, ...patch.workflow?.lineup } } };
      return structuredClone(session);
    }),
    resetGuidedSession: vi.fn(async () => session),
    getL0Models: vi.fn(async () => ({ models: [
      { provider: 'one', model: 'first', effort: 'high', spec: 'one:first@high', label: 'First' },
      { provider: 'two', model: 'second', effort: 'high', spec: 'two:second@high', label: 'Second' },
    ], auto_selected: 'one:first@high' })),
    getModelCatalog: vi.fn(async () => ({ ...BUILTIN_MODEL_CATALOG, cache: {} })),
    getLineupProfiles: vi.fn(async () => ({ profiles: [], last_used: null })),
    saveLineupProfile: vi.fn(),
    deleteLineupProfile: vi.fn(),
    saveLastUsedLineup: vi.fn(async () => ({ profiles: [], last_used: null })),
  };
  const container = document.createElement('div');
  let root = createRoot(container as unknown as HTMLElement);
  const onLaunched = vi.fn();
  const element = () => createElement(GuidedBrainstormStep, {
    locale: 'en', lineup: LINEUP, onLaunched, api, projectPath: '/repo', services: services as never,
  });
  await act(async () => root.render(element()));
  const byClass = (name: string) => findNode(container, (_node, props) =>
    typeof props.className === 'string' && props.className.split(' ').includes(name))!;
  const change = async (value: string) => act(async () => {
    const handler = reactProps(byClass('guided-brainstorm__input')).onChange as (event: unknown) => void;
    handler({ target: { value }, currentTarget: { value } });
  });
  const submit = async () => act(async () => {
    const handler = reactProps(byClass('guided-brainstorm__composer')).onSubmit as (event: unknown) => void;
    handler({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await change('Build it');
  await submit();
  expect(container.textContent).toContain('Todo app');
  expect(container.textContent).toContain('first-model');
  await act(async () => {
    const select = byClass('l0-model-switcher__select');
    (reactProps(select).onChange as (event: unknown) => void)({ currentTarget: { value: 'two:second@high' } });
  });
  await change('Change it');
  await submit();
  expect(container.textContent).toContain('Todo app');
  expect(container.textContent).not.toContain('Incorrect replacement');
  expect(container.textContent).toContain('Retry online');
  await act(async () => {
    (reactProps(byClass('guided-brainstorm__retry')).onClick as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.brainstormChat).toHaveBeenLastCalledWith(expect.objectContaining({ requested_l0_model: 'two:second@high' }));
  expect(container.textContent).toContain('second-model');
  expect(container.textContent).toContain('Recommended workflow');
  await vi.waitFor(() => expect(session.brainstorm.guided_turn_snapshot).toBeTruthy());
  await act(async () => root.unmount());
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(element()));
  expect(container.textContent).toContain('Todo app');
  expect(container.textContent).toContain('second-model');
  expect(reactProps(byClass('l0-model-switcher__select')).value).toBe('two:second@high');
  expect(container.textContent).toContain('Recommended workflow');

  await act(async () => {
    const toggle = findNode(container, (node, props) => node.nodeName === 'INPUT'
      && props.type === 'checkbox' && props.checked === false && typeof props['aria-describedby'] !== 'string')!;
    (reactProps(toggle).onChange as (event: unknown) => void)({ currentTarget: { checked: true } });
  });
  api.startRun.mockRejectedValueOnce(new ApiError(409, 'Panel unavailable', { code: 'LAUNCH_PREFLIGHT',
    codes: ['synthesizer_credentials_missing'], fallback: { ...recommendation, size: 'large', fallback: true,
      reason_code: 'synthesizer_credentials_missing', explanation_codes: ['synthesizer_credentials_missing'] } }));
  await act(async () => {
    (reactProps(byClass('guided-launch-bar__launch')).onClick as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain(MESSAGES.en.guided.m3.recommendation.reasons.synthesizer_credentials_missing);
  expect(findNode(container, (node, props) => node.nodeName === 'INPUT' && props.type === 'checkbox'
    && props.disabled === true && typeof props['aria-describedby'] === 'string')).toBeDefined();
  api.startRun.mockClear();
  let finish!: (value: { run_id: string }) => void;
  api.startRun.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => {
    const click = reactProps(byClass('guided-launch-bar__launch')).onClick as () => void;
    click();
    click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.startRun).toHaveBeenCalledOnce();
  expect(api.startRun).toHaveBeenCalledWith(expect.objectContaining({ launch_request_id: 'one-launch-id' }));
  expect(reactProps(byClass('guided-launch-bar__launch')).disabled).toBe(true);
  await act(async () => { finish({ run_id: 'run-42' }); });
  expect(onLaunched).toHaveBeenCalledOnce();
  await act(async () => root.unmount());

  session = { ...session, active_run_id: 'run-42', active_stage: 'blueprint',
    brainstorm: { ...session.brainstorm, replan_contexts: { 'run-42': JSON.stringify({
      run_summary: 'Build failed', failed_tasks: [{ id: 'T1', title: 'Tests' }], last_errors: { T1: 'pytest failed' },
    }) } }, workflow: { ...session.workflow, mode: 'overnight', lineup: { ...session.workflow.lineup, size: 'medium' } } };
  results.push(turnResult('Revised blueprint', true, { ...first, reply: 'Revised blueprint', responding_model: 'second-model',
    recommendation: { ...recommendation, mode: 'panel', size: 'large', size_changed: true,
      explanation_codes: ['previous_lineup_preserved'] } }));
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(element()));
  const countClear = (node: TestNode): number => {
    const classes = reactProps(node).className;
    return (typeof classes === 'string' && classes.includes('guided-brainstorm__item--clear') ? 1 : 0)
      + node.childNodes.reduce((total, child) => total + countClear(child), 0);
  };
  expect(countClear(container)).toBe(5);
  expect(container.textContent).toContain('Todo app');
  expect(findNode(container, (_node, props) => props.className === 'guided-launch-bar')).toBeUndefined();
  await change('Fix the tests');
  await submit();
  expect(api.brainstormChat).toHaveBeenLastCalledWith(expect.objectContaining({
    revision_context: { prior_rfc: first.rfc_markdown, requested_changes: 'Fix the tests' },
    failure_context: 'Build failed\nT1 — Tests\nT1: pytest failed',
    previous_lineup: expect.objectContaining({ roles: LINEUP.roles, size: 'medium' }),
  }));
  expect(findNode(container, (_node, props) => props['data-current-size'] === 'medium')).toBeDefined();
  expect(reactProps(byClass('guided-launch-bar__launch')).disabled).toBe(true);
  expect(container.textContent).toContain('cannot attach the stopped run');
  await act(async () => root.unmount());
});

/*
 * Work record 20261126-182700-m3-t3 (PST), branch baton/e33e97/m3-t3, base f3852b5.
 * Scope: the M3-T3 file whitelist. Added the session-backed brainstorm model,
 * protected retry, recommendation and lineup drawer, and keyed single-flight
 * launch. The whitelist excludes LOG.md and LOG-INDEX.md, so this record stays
 * with the regression test. No commit was created; base f3852b5 is the rollback
 * reference for the originally clean worktree.
 * Verification: 84 targeted tests and all 850 web tests passed with
 * --configLoader runner; TypeScript typecheck and production build passed.
 * The exact requested command failed at startup with EPERM writing the shared
 * node_modules/.vite-temp junction. Browser automation required an unavailable
 * approval; real-browser and user acceptance remain unverified.
 * Stop & Replan preserves the revision but its launch is disabled: startRun
 * cannot attach a parent. Sign-Off currently creates a child directly without
 * entering Blueprint. Both require parent/backend work outside this whitelist.
 * Status: partially self-tested; integration blocked, pending user acceptance.
 */
