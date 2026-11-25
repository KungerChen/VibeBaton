import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { BlueprintCard, BrainstormTurnResult, RecommendedLineup } from '../../api/client';
import {
  appendTurn,
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
});
