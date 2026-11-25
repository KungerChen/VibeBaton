import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { CliDriver, CliScanEntry, RecommendedLineup, WorkspaceInfo } from '../../api/client';
import {
  BUILTIN_MODEL_CATALOG,
  GuidedDriverRow,
  assignAllRoles,
  assignRoleModelSpec,
  assignRoleProvider,
  availableLineupProviders,
  buildTieredLineup,
  canInstall,
  confirmLineup,
  driverDisplayName,
  driversNeedingApiKey,
  filterDrivers,
  initGitAndRefresh,
  installWithConsent,
  isLineupCustomized,
  lineupSummary,
  modelsForProvider,
  providerTemplateSupport,
  scheduleStaleCatalogRefetch,
  STALE_CATALOG_REFETCH_MS,
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

  test('renders installing progress bar and localized feedback when activeAction matches', () => {
    const html = renderRow({ consent: true, busy: true, activeAction: 'install:dsh', feedback: null });
    expect(html).toContain('Installing…');
    expect(html).toContain('guided-setup__progress-bar');

    const doneHtml = renderRow({ consent: false, busy: false, feedback: 'Installed and rescanned.' });
    expect(doneHtml).toContain('Installed and rescanned.');
  });

  test('renders version badge and binary path for ready drivers without leaking opencode for dsh', () => {
    const readyEntry: CliScanEntry = {
      ...entry('ready', 'dsh', 'DSH is ready.'),
      version: '0.4.2',
      binary_path: 'C:\\tools\\dsh.cmd',
    };
    const html = renderRow({ entry: readyEntry });
    expect(html).toContain('0.4.2');
    expect(html).toContain('C:\\tools\\dsh.cmd');
    expect(html).not.toMatch(/opencode/i);
  });

  test('renders API key guidance and button when needsApiKey is provided on a ready driver', () => {
    const geminiDriver: CliDriver = { ...dsh, id: 'gemini', name: 'Gemini CLI', binary: 'gemini', provider_ids: ['gemini_http'], env_keys: ['GEMINI_API_KEY'] };
    const html = renderRow({
      driver: geminiDriver,
      entry: entry('ready', 'gemini'),
      needsApiKey: 'GEMINI_API_KEY',
      onConfigureApiKey: () => {},
    });
    expect(html).toContain('GEMINI_API_KEY');
    expect(html).toContain('Set API Key');
  });
});

describe('CLI filtering and team lineup customization helpers', () => {
  const claude: CliDriver = { ...dsh, id: 'claude', name: 'Claude Code', binary: 'claude', provider_ids: ['claude_sub'] };
  const codex: CliDriver = { ...dsh, id: 'codex', name: 'Codex CLI', binary: 'codex', provider_ids: ['codex_sub'] };
  const gemini: CliDriver = { ...dsh, id: 'gemini', name: 'Gemini CLI', binary: 'gemini', provider_ids: ['gemini_http'], env_keys: ['GEMINI_API_KEY'] };
  const opencode: CliDriver = { ...dsh, id: 'opencode', name: 'OpenCode', binary: 'opencode', provider_ids: ['dsh_opencode'] };

  test('filterDrivers filters all, ready, and needs_setup entries', () => {
    const drivers = [dsh, claude, codex];
    const entries: Record<string, CliScanEntry> = {
      dsh: entry('ready', 'dsh'),
      claude: entry('installed_unauthenticated', 'claude'),
      codex: entry('missing', 'codex'),
    };
    expect(filterDrivers(drivers, entries, 'all').map((d) => d.id)).toEqual(['dsh', 'claude', 'codex']);
    expect(filterDrivers(drivers, entries, 'ready').map((d) => d.id)).toEqual(['dsh']);
    expect(filterDrivers(drivers, entries, 'needs_setup').map((d) => d.id)).toEqual(['claude', 'codex']);
  });

  test('availableLineupProviders gathers ready configured CLI providers and filters unsafe bindings', () => {
    const base = lineup(true);
    const entries: Record<string, CliScanEntry> = {
      dsh: entry('ready', 'dsh'),
      claude: entry('ready', 'claude'),
      codex: entry('ready', 'codex'),
      gemini: entry('ready', 'gemini'),
      opencode: entry('ready', 'opencode'),
    };
    expect(
      availableLineupProviders(base, [dsh, claude, codex, gemini, opencode], entries, ['dsh_opencode', 'claude_sub', 'codex_sub', 'gemini_http']),
    ).toEqual(['dsh_opencode', 'claude_sub', 'codex_sub']);

    expect(
      availableLineupProviders(base, [dsh, claude, codex, gemini], entries, ['dsh_opencode', 'claude_sub', 'gemini_http'], ['GEMINI_API_KEY']),
    ).toEqual(['dsh_opencode', 'claude_sub', 'gemini_http']);

    expect(driversNeedingApiKey([dsh, claude, gemini], entries, [])).toEqual([{ driver: gemini, envKey: 'GEMINI_API_KEY' }]);
    expect(driversNeedingApiKey([dsh, claude, gemini], entries, ['GEMINI_API_KEY'])).toEqual([]);
  });

  test('assignAllRoles, assignRoleProvider, assignRoleModelSpec, and isLineupCustomized update roles and overrides immutably', () => {
    const base: RecommendedLineup = {
      ready: true,
      roles: {
        brainstorm_and_final_gate: 'gemini_sub',
        tactical_planner: 'claude_sub',
        critical_executor: 'codex_sub',
        bulk_worker: 'dsh_opencode',
      },
      source: 'cli',
      notes_en: 'Ready.',
      notes_zh: '就绪。',
    };
    const tiered = buildTieredLineup(base, ['gemini_sub', 'claude_sub', 'codex_sub', 'dsh_opencode'], BUILTIN_MODEL_CATALOG);
    expect(tiered.model_overrides).toEqual({
      brainstorm_and_final_gate: 'gemini_sub:gemini-4-carbon@medium',
      tactical_planner: 'claude_sub:claude-opus-5-5@medium',
      critical_executor: 'codex_sub:gpt-6.2-sol@max',
      bulk_worker: 'dsh_opencode:deepseek-v4.1-flash@max',
    });

    const summaryZh = lineupSummary(tiered, 'zh', BUILTIN_MODEL_CATALOG.models);
    expect(summaryZh).toContain('Gemini 4C · Medium');
    expect(summaryZh).toContain('Opus 5.5 · Medium');
    expect(summaryZh).toContain('GPT-6.2 Sol · Max');
    expect(summaryZh).toContain('DeepSeek V4.1 Flash · Max');
    expect(summaryZh).not.toMatch(/opencode/i);

    const offlineClaudeIds = modelsForProvider(BUILTIN_MODEL_CATALOG.models, 'claude_sub').map((m) => m.id);
    expect(offlineClaudeIds).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);

    const uniform = assignAllRoles(tiered, 'claude_sub', BUILTIN_MODEL_CATALOG);
    expect(uniform.roles).toEqual({
      brainstorm_and_final_gate: 'claude_sub',
      tactical_planner: 'claude_sub',
      critical_executor: 'claude_sub',
      bulk_worker: 'claude_sub',
    });
    expect(uniform.model_overrides?.brainstorm_and_final_gate).toBe('claude_sub:claude-fable-5-2@medium');
    expect(isLineupCustomized(tiered, uniform)).toBe(true);

    const swappedModel = assignRoleModelSpec(tiered, 'tactical_planner', 'claude_sub', 'claude-opus-4-6', 'high');
    expect(swappedModel.model_overrides?.tactical_planner).toBe('claude_sub:claude-opus-4-6@high');
    expect(isLineupCustomized(tiered, swappedModel)).toBe(true);

    const singleProviderSwap = assignRoleProvider(tiered, 'critical_executor', 'gemini_sub', BUILTIN_MODEL_CATALOG);
    expect(singleProviderSwap.model_overrides?.critical_executor).toBe('gemini_sub:gemini-4-hydrogen@max');
  });

  test('the offline fallback catalog only carries the recommended models; the server owns the full list', () => {
    const recommended = new Set(Object.values(BUILTIN_MODEL_CATALOG.tier_recommendations).flat().map((rec) => rec.model));
    expect(new Set(BUILTIN_MODEL_CATALOG.models.map((m) => m.id))).toEqual(recommended);
  });
});

describe('scheduleStaleCatalogRefetch', () => {
  const cache = (stale: boolean) => ({
    cache: { path: 'c.json', fetched_at: null, age_sec: null, stale, refresh_interval_hours: 24, last_error: null },
  });

  test('re-reads a stale catalog once after the delay and can be cancelled', () => {
    vi.useFakeTimers();
    try {
      const refetch = vi.fn();
      const cancel = scheduleStaleCatalogRefetch(cache(true), refetch);
      expect(cancel).toBeTypeOf('function');
      vi.advanceTimersByTime(STALE_CATALOG_REFETCH_MS - 1);
      expect(refetch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(refetch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(STALE_CATALOG_REFETCH_MS * 5);
      expect(refetch).toHaveBeenCalledTimes(1);

      const cancelledRefetch = vi.fn();
      scheduleStaleCatalogRefetch(cache(true), cancelledRefetch)?.();
      vi.advanceTimersByTime(STALE_CATALOG_REFETCH_MS);
      expect(cancelledRefetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does nothing for a fresh catalog or when the catalog is unavailable', () => {
    const refetch = vi.fn();
    expect(scheduleStaleCatalogRefetch(cache(false), refetch)).toBeNull();
    expect(scheduleStaleCatalogRefetch(null, refetch)).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe('providerTemplateSupport', () => {
  test('reads which pickers the loaded command template actually uses', () => {
    expect(providerTemplateSupport(['claude', '-p', '--model', '{model_name}', '--effort', '{effort}'])).toEqual({ model: true, effort: true });
    expect(providerTemplateSupport(['gemini', '--model', '{model_name}', '-p', '.'])).toEqual({ model: true, effort: false });
    expect(providerTemplateSupport(['dsh', '--profile', 'headless', '--json', '-'])).toEqual({ model: false, effort: false });
    // {model} carries the whole model@effort spec.
    expect(providerTemplateSupport(['tool', '--model={model}'])).toEqual({ model: true, effort: true });
  });

  test('HTTP providers (no command) and unknown providers keep both pickers', () => {
    expect(providerTemplateSupport([])).toEqual({ model: true, effort: true });
    expect(providerTemplateSupport(undefined)).toEqual({ model: true, effort: true });
  });
});
