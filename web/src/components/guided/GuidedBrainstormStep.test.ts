import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { BlueprintCard, BrainstormTurnResult, RecommendedLineup } from '../../api/client';
import {
  appendTurn,
  BRAINSTORM_SCENARIOS,
  BrainstormTurn,
  canLaunch,
  confirmAndStart,
  GuidedBrainstormStep,
  readinessTone,
  sendBrainstormTurn,
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

function turnResult(reply: string, ready: boolean): BrainstormTurnResult {
  return {
    reply,
    rfc_markdown: `# Todo\n\n${reply}`,
    blueprint: card(ready ? 92 : 40, ready),
    provider_used: null,
    offline: true,
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

describe('pure helpers', () => {
  test('appendTurn returns a new array and leaves the input untouched', () => {
    const before = [{ role: 'user' as const, content: 'hi' }];
    const after = appendTurn(before, 'assistant', 'hello');
    expect(after).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
    expect(before).toHaveLength(1);
  });

  test('readinessTone bands the score', () => {
    expect(readinessTone(0)).toBe('low');
    expect(readinessTone(49)).toBe('low');
    expect(readinessTone(50)).toBe('medium');
    expect(readinessTone(79)).toBe('medium');
    expect(readinessTone(80)).toBe('high');
    expect(readinessTone(100)).toBe('high');
  });

  test('canLaunch requires ready_to_launch', () => {
    expect(canLaunch(null)).toBe(false);
    expect(canLaunch(card(95, false))).toBe(false);
    expect(canLaunch(card(95, true))).toBe(true);
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

  test('renders localized labels and scenario cards', () => {
    const zh = render('zh');
    expect(zh).toContain('你想做什么？');
    expect(zh).toContain('确认蓝图并开始施工');
    expect(zh).toContain('交付一个新功能');
    const en = render('en');
    expect(en).toContain('Confirm Blueprint &amp; Start Building');
    expect(en).toContain('Ship a new feature');
  });

  test('offers every scenario and says what to write', () => {
    expect(BRAINSTORM_SCENARIOS.map((item) => item.id)).toEqual([
      'new_feature', 'bug_fix', 'refactor', 'add_tests', 'web_app', 'performance',
      'ui_redesign', 'dependency_upgrade', 'write_docs', 'script_or_data', 'not_sure',
    ]);
    const zh = render('zh');
    for (const item of BRAINSTORM_SCENARIOS) expect(zh).toContain(item.title_zh);
    expect(zh).toContain('guided-brainstorm__input-hint');
    expect(zh).toContain('怎么算完成');
    const en = render('en');
    expect(en).toContain('how you will know it is done');
    for (const item of BRAINSTORM_SCENARIOS) expect(item.prompt_en.split('\n')).toHaveLength(5);
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
