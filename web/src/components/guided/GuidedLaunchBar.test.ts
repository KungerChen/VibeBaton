import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { GuidedSession, RecommendedLineup, WorkflowRecommendation } from '../../api/client';
import { MESSAGES } from '../../i18n/messages';
import { GuidedLaunchBar, type GuidedLaunchBarProps } from './GuidedLaunchBar';
import { initialWorkflow } from './GuidedBrainstormStep';
import { BUILTIN_MODEL_CATALOG } from './GuidedSetupStep';

const lineup: RecommendedLineup = {
  ready: true, roles: { planner: 'codex_sub' },
  model_overrides: { planner: 'codex_sub:gpt-6.2-sol@high' }, source: 'cli', notes_en: '', notes_zh: '',
};
const recommendation: WorkflowRecommendation = {
  mode: 'overnight', preset: 'solo_coder_3tier', size: 'large',
  lineup: { roles: lineup.roles, model_overrides: lineup.model_overrides!, size: 'medium' },
  reason_code: 'synthesizer_credentials_missing', explanation_key: 'workflow.synthesizer_credentials_missing',
  explanation_codes: ['synthesizer_credentials_missing', 'previous_lineup_preserved'],
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

describe('GuidedLaunchBar', () => {
  test('shows the backend recommendation, fallback explanation and disabled panel reason', () => {
    const html = renderToStaticMarkup(createElement(GuidedLaunchBar, props()));
    expect(html).toContain('Recommended workflow');
    expect(html).toContain('Overnight');
    expect(html).toContain(MESSAGES.en.guided.m3.recommendation.reasons.synthesizer_credentials_missing);
    expect(html).toContain(MESSAGES.en.guided.m3.recommendation.reasons.previous_lineup_preserved);
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""[^>]*aria-describedby=/);
    expect(html).toContain('guided-launch-bar__panel-hint');
  });

  test('offers role, provider, model, effort and saved lineup controls', () => {
    const html = renderToStaticMarkup(createElement(GuidedLaunchBar, props()));
    for (const value of ['planner', 'Provider', 'Model', 'Effort', 'My team', 'codex_sub']) expect(html).toContain(value);
    expect(html).toContain('<details');
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
