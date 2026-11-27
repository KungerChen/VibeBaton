import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { GuidedSession, RecommendedLineup, WorkflowRecommendation } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import {
  GuidedLaunchBar, panelToggleState, recommendationHeadline, recommendationReasons, teamRows,
  type GuidedLaunchBarProps,
} from './GuidedLaunchBar';
import { initialWorkflow } from './GuidedBrainstormStep';
import { BUILTIN_MODEL_CATALOG } from './GuidedSetupStep';

const lineup: RecommendedLineup = {
  ready: true, roles: { planner: 'codex_sub' },
  model_overrides: { planner: 'codex_sub:gpt-6.2-sol@high' }, source: 'cli', notes_en: '', notes_zh: '',
};
const recommendation: WorkflowRecommendation = {
  mode: 'overnight', preset: null, size: 'large',
  lineup: { roles: lineup.roles, model_overrides: lineup.model_overrides!, size: 'medium' },
  reason_code: 'large_relay', explanation_key: 'workflow.large_relay',
  explanation_codes: ['size_estimated', 'large_relay', 'synthesizer_credentials_missing'],
  fallback: true, size_changed: true, substitutions: [],
};
const session: GuidedSession = {
  schema_version: 1, active_stage: 'blueprint', workspace_path: '/repo', active_run_id: 'previous-run',
  brainstorm: { messages: [], checklist: [], latest_rfc_draft: '# old', selected_l0_model: null, has_online_draft: true },
  workflow: { mode: 'panel', preset: 'specialist_panel', panel_enabled: true,
    lineup: { roles: lineup.roles, model_overrides: lineup.model_overrides!, size: 'medium' }, launch_request_id: 'old-key' },
  open_human_gate: null, open_drawer: null,
};

function props(overrides: Partial<GuidedLaunchBarProps> = {}): GuidedLaunchBarProps {
  return {
    recommendation, lineup, mode: 'overnight', previousSize: 'medium', showSwitch: true,
    panelFailure: MESSAGES.en.guided.m3.recommendation.reasons.synthesizer_credentials_missing,
    providers: ['codex_sub'], catalog: BUILTIN_MODEL_CATALOG,
    profiles: [{ id: 'one', name: 'My team', roles: lineup.roles, model_overrides: lineup.model_overrides!, updated_at: 1 }],
    pending: false, disabled: false, onLineupChange: vi.fn(), onModeChange: vi.fn(),
    onSwitch: vi.fn(), onDismissSwitch: vi.fn(), onSaveProfile: vi.fn(), onDeleteProfile: vi.fn(), onLaunch: vi.fn(),
    ...overrides,
  };
}

const copy = MESSAGES.en.guided.m3.recommendation;

describe('GuidedLaunchBar', () => {
  test('shows one conclusion, the ordered reasons and the disabled panel reason', () => {
    const html = renderToStaticMarkup(createElement(GuidedLaunchBar, props()));
    expect(html).toContain('Recommended plan');
    expect(html).toContain('This is a large project. The team below will build it automatically');
    expect(html).toContain('Judged a large project from what the blueprint lists.');
    expect(html).toContain(copy.reasons.large_relay);
    expect(html).toContain(copy.reasons.synthesizer_credentials_missing);
    expect(html).toMatch(/type="checkbox" role="switch"[^>]*disabled=""/);
    expect(html).toContain(copy.panelHelp);
    expect(html).toContain(copy.panelUnavailable);
    expect(html).not.toContain('Overnight');
  });

  test('the team table shows display names, never raw provider:model@effort strings', () => {
    const html = renderToStaticMarkup(createElement(GuidedLaunchBar, props()));
    expect(html).not.toContain('codex_sub:gpt-6.2-sol@high');
    const team = html.slice(html.indexOf('guided-launch-bar__team'), html.indexOf('guided-launch-bar__panel'));
    expect(team).not.toMatch(/\w+:[\w.-]+@\w+/);
    for (const header of ['Role', 'Tool', 'Model', 'Thinking effort']) expect(team).toContain(header);
  });

  test('offers role, tool, model, effort and saved lineup controls in the drawer', () => {
    const html = renderToStaticMarkup(createElement(GuidedLaunchBar, props()));
    for (const value of ['Change team', 'Tool', 'Model', 'Thinking effort', 'My team', 'codex_sub']) expect(html).toContain(value);
    expect(html).toContain('<details');
    expect(html).toContain('class="guided-setup__input"');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  test('a partly ready panel stays available and names the missing specialists', () => {
    const partial = { ...recommendation, missing_panelists: ['codex_sub', 'dsh_opencode'] };
    const html = renderToStaticMarkup(createElement(GuidedLaunchBar, props({ recommendation: partial, panelFailure: null })));
    expect(html).toContain('Some specialists are not ready (OpenAI Codex, DSH)');
    expect(html).not.toMatch(/role="switch"[^>]*disabled=""/);
  });

  test('a pending start disables the launch action and leaves the size switch visible', () => {
    const html = renderToStaticMarkup(createElement(GuidedLaunchBar, props({ pending: true })));
    expect(html).toMatch(/class="guided-launch-bar__launch" disabled=""/);
    expect(html).toContain(MESSAGES.en.guided.m3.launch.launching);
    expect(html).toContain('data-current-size="medium"');
  });

  test('does not show the size switch when sizes match or the user dismissed it', () => {
    expect(renderToStaticMarkup(createElement(GuidedLaunchBar, props({ showSwitch: false })))).not.toContain('workflow-switch-pill');
    expect(renderToStaticMarkup(createElement(GuidedLaunchBar, props({ previousSize: 'large' })))).not.toContain('workflow-switch-pill');
  });
});

describe('recommendation display helpers', () => {
  test('team rows use catalog model and effort labels', () => {
    const [row] = teamRows(lineup, BUILTIN_MODEL_CATALOG, 'en', 'Tool default');
    const model = BUILTIN_MODEL_CATALOG.models.find((entry) => entry.id === 'gpt-6.2-sol')!;
    const effort = BUILTIN_MODEL_CATALOG.efforts.find((entry) => entry.id === 'high')!;
    expect(row).toEqual({ role: 'planner', roleLabel: 'planner', tool: 'OpenAI Codex', model: model.label, effort: effort.label });
    expect(teamRows({ roles: { bulk_worker: 'dsh_opencode' }, model_overrides: {} }, BUILTIN_MODEL_CATALOG, 'zh', '工具默认')[0])
      .toMatchObject({ tool: 'DSH', model: '工具默认', effort: '' });
  });

  test('reasons keep backend order, fill names and stop at three', () => {
    const many = { ...recommendation, explanation_codes: ['size_from_model', 'large_relay', 'panelist_not_ready', 'provider_substituted'],
      missing_panelists: ['codex_sub'] };
    expect(recommendationReasons(many, copy)).toEqual([
      'The AI partner judged this a large project.', copy.reasons.large_relay, 'Some panel specialists are not ready: OpenAI Codex.',
    ]);
    expect(recommendationReasons({ ...recommendation, explanation_codes: ['mystery'] }, copy)).toEqual([copy.unknownReason]);
    const zh = MESSAGES.zh.guided.m3.recommendation;
    expect(recommendationHeadline({ ...recommendation, reason_code: 'small_eco', size: 'small' }, zh))
      .toBe('这是个小项目，建议用精简团队自动施工。');
    expect(recommendationHeadline({ ...recommendation, lineup: null }, copy)).toBe(copy.headlines.no_lineup);
  });

  test('the panel switch is disabled with a reason only when the panel cannot run', () => {
    expect(panelToggleState('Needs a key.', false)).toEqual({ disabled: true, reason: 'Needs a key.' });
    expect(panelToggleState(null, false)).toEqual({ disabled: false, reason: null });
    expect(panelToggleState(null, true)).toEqual({ disabled: true, reason: null });
  });
});

describe('workflow restoration', () => {
  test('uses the backend revalidated previous lineup and rejects an unavailable panel', () => {
    const result = initialWorkflow(recommendation, session, lineup);
    expect(result.lineup.roles).toEqual(session.workflow.lineup.roles);
    expect(result.lineup.model_overrides).toEqual(session.workflow.lineup.model_overrides);
    expect(result.mode).toBe('overnight');
    expect(result.showSwitch).toBe(true);
  });

  test('replaces an invalid previous lineup with the backend repair and only proposes actual size changes', () => {
    const repaired = { ...recommendation, lineup: { roles: { planner: 'gemini_sub' }, model_overrides: {}, size: 'medium' as const },
      size: 'medium' as const, size_changed: false, explanation_codes: ['provider_substituted'] };
    const result = initialWorkflow(repaired, session, lineup);
    expect(result.lineup.roles).toEqual({ planner: 'gemini_sub' });
    expect(result.showSwitch).toBe(false);
    expect(initialWorkflow(recommendation, { ...session, active_run_id: null }, lineup).showSwitch).toBe(false);
  });
});
