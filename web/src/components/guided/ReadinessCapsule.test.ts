import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { MESSAGES, type Locale } from '../../i18n/messages';
import type { WorkspaceReadiness } from './GuidedSetupStep';
import { ReadinessCapsule, readinessReasonTexts, type ReadinessCapsuleProps } from './ReadinessCapsule';

function props(overrides: Partial<ReadinessCapsuleProps> = {}): ReadinessCapsuleProps {
  return {
    locale: 'en', readiness: { state: 'ready', reasons: [] }, failed: false, checking: false,
    workspacePath: 'D:\\Projects\\demo', expanded: false, onToggle: vi.fn(), onRefresh: vi.fn(), ...overrides,
  };
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)] : []);
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const STATES: [WorkspaceReadiness['state'], WorkspaceReadiness, string][] = [
  ['ready', { state: 'ready', reasons: [] }, 'lucide-circle-check'],
  ['partial', { state: 'partial', reasons: [{ code: 'tools_unavailable', providers: ['claude_sub'] }] }, 'lucide-triangle-alert'],
  ['blocked', { state: 'blocked', reasons: [{ code: 'no_git' }] }, 'lucide-circle-x'],
];

describe('ReadinessCapsule', () => {
  test.each(STATES)('shows the %s state with both words and its own icon', (state, readiness, icon) => {
    for (const locale of ['en', 'zh'] as const) {
      const html = renderToStaticMarkup(createElement(ReadinessCapsule, props({ locale, readiness })));
      expect(html).toContain(`data-state="${state}"`);
      expect(visibleText(html)).toContain(MESSAGES[locale].guided.m3.readiness[state]);
      expect(html).toContain(icon);
      for (const [other, , otherIcon] of STATES) if (other !== state) expect(html).not.toContain(otherIcon);
    }
  });

  test('writes the reasons in plain words, naming tools by their display names', () => {
    const copy = MESSAGES.en.guided.m3.readiness;
    expect(readinessReasonTexts({ state: 'blocked', reasons: [{ code: 'no_git' }, { code: 'no_commits' }, { code: 'no_team' }] },
      false, 'en')).toEqual([copy.noGit, copy.noCommits, copy.noTeam]);
    const partial: WorkspaceReadiness = { state: 'partial', reasons: [{ code: 'tools_unavailable', providers: ['claude_sub', 'codex_sub'] }] };
    expect(readinessReasonTexts(partial, false, 'en')).toEqual(['Not ready: Claude Code, OpenAI Codex']);
    expect(readinessReasonTexts(partial, false, 'zh')).toEqual(['未就绪：Claude Code、OpenAI Codex']);
    const html = renderToStaticMarkup(createElement(ReadinessCapsule, props({ readiness: partial })));
    expect(visibleText(html)).toContain('Not ready: Claude Code, OpenAI Codex');
    expect(html).not.toContain('claude_sub');
    expect(readinessReasonTexts({ state: 'ready', reasons: [] }, false, 'en')).toEqual([]);
  });

  test('a check that could not run shows as blocked with that reason', () => {
    const html = renderToStaticMarkup(createElement(ReadinessCapsule, props({ readiness: { state: 'ready', reasons: [] }, failed: true })));
    expect(html).toContain('data-state="blocked"');
    expect(visibleText(html)).toContain(MESSAGES.en.guided.m3.readiness.checkFailed);
  });

  test('says it is still checking until a verdict exists, and always names the folder', () => {
    const locales: Locale[] = ['en', 'zh'];
    for (const locale of locales) {
      const html = renderToStaticMarkup(createElement(ReadinessCapsule, props({ locale, readiness: null, checking: true })));
      expect(html).toContain('data-state="checking"');
      expect(visibleText(html)).toContain(MESSAGES[locale].guided.m3.readiness.checking);
      expect(html).toContain('D:\\Projects\\demo');
    }
  });

  test('the pill opens and closes the wizard, and a separate button checks again', () => {
    const onToggle = vi.fn();
    const onRefresh = vi.fn();
    const tree = elements(ReadinessCapsule(props({ onToggle, onRefresh, expanded: true })));
    const pill = tree.find((node) => node.props.className === 'readiness-capsule__pill');
    const refresh = tree.find((node) => node.props.className === 'readiness-capsule__refresh');
    expect(pill?.props['aria-expanded']).toBe(true);
    expect(refresh?.props['aria-label']).toBe(MESSAGES.en.guided.m3.readiness.refresh);
    (pill?.props.onClick as () => void)();
    (refresh?.props.onClick as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();
    const checking = elements(ReadinessCapsule(props({ checking: true })))
      .find((node) => node.props.className === 'readiness-capsule__refresh');
    expect(checking?.props.disabled).toBe(true);
  });
});
