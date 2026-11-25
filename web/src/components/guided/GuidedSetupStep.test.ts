import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { CliDriver, CliScanEntry, RecommendedLineup, WorkspaceInfo } from '../../api/client';
import {
  GuidedDriverRow,
  canInstall,
  confirmLineup,
  driverDisplayName,
  initGitAndRefresh,
  installWithConsent,
  lineupSummary,
  type GuidedDriverRowProps,
} from './GuidedSetupStep';

const dsh: CliDriver = {
  id: 'dsh', name: 'DSH', tier: 'official', binary: 'dsh',
  summary_en: 'DSH runs headless sessions through a DeepSeek-hosted OpenCode Go profile.', summary_zh: 'DSH zh',
  prereq: ['node'], install_cmd: ['npm', 'install', '-g', '@deepseek-ai/dsh'], login_cmd: ['dsh'],
  official_url: 'https://www.npmjs.com/package/@deepseek-ai/dsh',
  command_template: ['dsh', '--patch', 'dsh-headless-opencode-go.patch.yml'], version_cmd: ['dsh', '--version'],
  provider_ids: ['dsh_opencode'], env_keys: ['OPENCODE_API_KEY'], auth_check_cmd: null,
};

function entry(status: CliScanEntry['status'], id = 'dsh', reason = 'Reason.'): CliScanEntry {
  return { id, status, binary_path: null, version: null, prereq_missing: [], reason_en: reason, reason_zh: reason };
}

const lineup = (ready: boolean): RecommendedLineup => ({
  ready, roles: ready ? { planner: 'dsh_opencode', coder: 'claude_sub' } : {}, source: 'cli',
  notes_en: 'Install Claude Code to continue.', notes_zh: '安装 Claude Code 以继续。',
});

function renderRow(overrides: Partial<GuidedDriverRowProps>): string {
  return renderToStaticMarkup(createElement(GuidedDriverRow, {
    locale: 'en', driver: dsh, entry: entry('missing'), consent: false, busy: false, login: null,
    onConsentChange: () => {}, onInstall: () => {}, onLogin: () => {}, ...overrides,
  }));
}

describe('driverDisplayName', () => {
  test('shows DSH for dsh and the registry name otherwise', () => {
    expect(driverDisplayName({ id: 'dsh', name: 'DSH' })).toBe('DSH');
    expect(driverDisplayName({ id: 'dsh', name: 'dsh_opencode' })).toBe('DSH');
    expect(driverDisplayName({ id: 'claude', name: 'Claude Code' })).toBe('Claude Code');
    expect(driverDisplayName({ id: 'qwen', name: '  ' })).toBe('qwen');
  });
});

describe('lineupSummary', () => {
  test('lists roles with display provider names and never leaks dsh_opencode', () => {
    const en = lineupSummary(lineup(true), 'en');
    expect(en).toContain('DSH');
    expect(en).toContain('claude_sub');
    expect(en).not.toMatch(/opencode/i);
    expect(lineupSummary(lineup(true), 'zh')).toContain('，');
  });

  test('falls back to the localized next step when no roles are assigned', () => {
    expect(lineupSummary(lineup(false), 'en')).toBe('Install Claude Code to continue.');
    expect(lineupSummary(lineup(false), 'zh')).toBe('安装 Claude Code 以继续。');
  });
});

describe('install consent guard', () => {
  test('canInstall needs a missing CLI and ticked consent', () => {
    expect(canInstall(entry('missing'), true)).toBe(true);
    expect(canInstall(entry('missing'), false)).toBe(false);
    expect(canInstall(entry('ready'), true)).toBe(false);
    expect(canInstall(entry('prereq_missing'), true)).toBe(false);
    expect(canInstall(undefined, true)).toBe(false);
  });

  test('installCli is never called without consent', async () => {
    const api = { installCli: vi.fn() };
    expect(await installWithConsent(api, entry('missing'), false)).toBe(false);
    expect(await installWithConsent(api, entry('ready'), true)).toBe(false);
    expect(await installWithConsent(api, undefined, true)).toBe(false);
    expect(api.installCli).not.toHaveBeenCalled();
  });

  test('install payload is exactly { cliId, confirmed: true }', async () => {
    const api = { installCli: vi.fn().mockResolvedValue({ id: 'dsh', ok: true, command: [], returncode: 0, output: '' }) };
    expect(await installWithConsent(api, entry('missing'), true)).toBe(true);
    expect(api.installCli).toHaveBeenCalledTimes(1);
    expect(api.installCli.mock.calls[0]).toEqual([{ cliId: 'dsh', confirmed: true }]);
  });

  test('installWithConsent surfaces installer failure when ok is false', async () => {
    const api = {
      installCli: vi.fn().mockResolvedValue({
        id: 'dsh',
        ok: false,
        command: ['npm', 'install'],
        returncode: 1,
        output: 'EACCES permission denied',
      }),
    };
    await expect(installWithConsent(api, entry('missing'), true)).rejects.toThrow('EACCES permission denied');
  });
});

describe('initGitAndRefresh', () => {
  test('initializes Git and then re-reads workspace info', async () => {
    const before: WorkspaceInfo = { path: '/repo', is_git_repo: false, branch: null, has_commits: false, has_rfc: false };
    const after: WorkspaceInfo = { ...before, is_git_repo: true, branch: 'main', has_commits: true };
    const order: string[] = [];
    const api = {
      initGitWorkspace: vi.fn(async () => { order.push('init'); return { ...after, created: true }; }),
      getWorkspaceInfo: vi.fn(async () => { order.push('info'); return after; }),
    };
    await expect(initGitAndRefresh(api)).resolves.toEqual(after);
    expect(order).toEqual(['init', 'info']);
  });
});

describe('confirmLineup', () => {
  test('a ready lineup triggers onReady with that lineup; otherwise nothing fires', () => {
    const onReady = vi.fn();
    const ready = lineup(true);
    expect(confirmLineup(ready, onReady)).toBe(true);
    expect(onReady).toHaveBeenCalledWith(ready);
    onReady.mockClear();
    expect(confirmLineup(lineup(false), onReady)).toBe(false);
    expect(confirmLineup(null, onReady)).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe('GuidedDriverRow', () => {
  test('never renders opencode for the dsh driver in any status', () => {
    const leaky = 'Uses the dsh_opencode provider via OpenCode Go.';
    const login = { id: 'dsh', launched: true, command: ['dsh'], message_en: leaky, message_zh: leaky };
    for (const status of ['ready', 'installed_unauthenticated', 'missing', 'prereq_missing'] as const) {
      const html = renderRow({ entry: entry(status, 'dsh', leaky), login });
      expect(html).toContain('DSH');
      expect(html).not.toMatch(/opencode/i);
    }
  });

  test('install button stays disabled until consent is ticked', () => {
    expect(renderRow({ consent: false })).toMatch(/<button[^>]*disabled=""[^>]*>Install<\/button>/);
    expect(renderRow({ consent: true })).toMatch(/<button[^>]*>Install<\/button>/);
    expect(renderRow({ consent: true })).not.toMatch(/disabled=""[^>]*>Install/);
  });

  test('after login shows the official URL and the terminal-window note', () => {
    const login = {
      id: 'dsh', launched: true, command: ['dsh'],
      message_en: 'Started `dsh`. Finish signing in to DSH in the new window, then rescan.', message_zh: 'zh',
    };
    const html = renderRow({ entry: entry('installed_unauthenticated'), login });
    expect(html).toContain('Sign In');
    expect(html).toContain('https://www.npmjs.com/package/@deepseek-ai/dsh');
    expect(html).toContain('in the new window');
  });
});
