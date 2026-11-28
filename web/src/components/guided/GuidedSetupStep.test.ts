import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CliDriver, CliInstallResult, CliLoginResult, CliRegistryScanResponse, CliScanEntry, GuidedSession, GuidedSessionPatch, ModelCatalogEntry, RecommendedLineup, WorkspaceInfo } from '../../api/client';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import {
  BUILTIN_MODEL_CATALOG,
  GuidedDriverRow,
  GuidedSetupStep,
  applySavedLineup,
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
  matchSavedProfile,
  closestEffort,
  coerceEffort,
  describeCorrections,
  effortOptionsFor,
  effortSourceFor,
  legalDefaultEffort,
  normalizeRoleEffort,
  modelsForProvider,
  providerTemplateSupport,
  recommendRoleSpec,
  scheduleStaleCatalogRefetch,
  STALE_CATALOG_REFETCH_MS,
  historyAllowsBuild,
  workspaceHistoryState,
  workspaceReadiness,
  type GuidedDriverRowProps,
  type GuidedSetupStepProps,
  type SetupReadinessInput,
  type SetupReadinessReport,
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
    expect(en).toContain('Claude Code');
    expect(en).not.toContain('claude_sub');
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

describe('workspace history gate', () => {
  const base: WorkspaceInfo = { path: '/repo', is_git_repo: true, branch: 'main', has_commits: true, has_rfc: false };

  test('a repo without a first commit asks for one and blocks the build', () => {
    const empty = { ...base, has_commits: false };
    expect(workspaceHistoryState(empty)).toBe('no-commits');
    expect(historyAllowsBuild(empty)).toBe(false);
    const notGit = { ...base, is_git_repo: false, branch: null, has_commits: false };
    expect(workspaceHistoryState(notGit)).toBe('missing');
    expect(historyAllowsBuild(notGit)).toBe(false);
  });

  test('a repo with commits, or no info yet, lets the build continue', () => {
    expect(workspaceHistoryState(base)).toBe('ready');
    expect(historyAllowsBuild(base)).toBe(true);
    expect(workspaceHistoryState(null)).toBe('unknown');
    expect(historyAllowsBuild(null)).toBe(true);
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

  test('offers installation without a checkbox and shows the exact command in its confirmation', () => {
    const closed = renderRow({ consent: false });
    expect(closed).toMatch(/<button[^>]*>Install<\/button>/);
    expect(closed).not.toContain('type="checkbox"');
    expect(closed).not.toContain('role="dialog"');
    const open = renderRow({ installOpen: true });
    expect(open).toContain('role="dialog"');
    expect(open).toContain('npm install -g @deepseek-ai/dsh');
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
    // Gemini CLI does not offer the Gemini 4 line, so L0 goes to Claude; with no Codex list the offline
    // catalog only vouches for low/medium/high, so Sol's max becomes high.
    expect(tiered.model_overrides).toEqual({
      brainstorm_and_final_gate: 'claude_sub:claude-fable-5-2@medium',
      tactical_planner: 'claude_sub:claude-opus-5-5@medium',
      critical_executor: 'codex_sub:gpt-6.2-sol@high',
      bulk_worker: 'dsh_opencode:deepseek-v4.1-flash@max',
    });

    const summaryZh = lineupSummary(tiered, 'zh', BUILTIN_MODEL_CATALOG.models);
    expect(summaryZh).toContain('Claude Fable 5.2 · Medium');
    expect(summaryZh).toContain('Claude Opus 5.5 · Medium');
    expect(summaryZh).toContain('GPT-6.2 Sol · High');
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

    // The offline catalog has no Gemini CLI model, so the role falls back to the CLI's own default model.
    const singleProviderSwap = assignRoleProvider(tiered, 'critical_executor', 'gemini_sub', BUILTIN_MODEL_CATALOG);
    expect(singleProviderSwap.roles.critical_executor).toBe('gemini_sub');
    expect(singleProviderSwap.model_overrides?.critical_executor).toBeUndefined();
    const agySwap = assignRoleProvider(tiered, 'critical_executor', 'agy_sub', BUILTIN_MODEL_CATALOG);
    expect(agySwap.model_overrides?.critical_executor).toBe('agy_sub:gemini-4-hydrogen@high');
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

  test('DSH reads model@effort from VIBEBATON_MODEL through the bundled patch file', () => {
    const dshCommand = [
      'dsh', '--profile', 'headless', '--patch', '{package_root}/presets/dsh-headless-opencode-go.patch.yml', '--json', '-',
    ];
    expect(providerTemplateSupport(dshCommand)).toEqual({ model: true, effort: true });
  });

  test('HTTP providers (no command) and unknown providers keep both pickers', () => {
    expect(providerTemplateSupport([])).toEqual({ model: true, effort: true });
    expect(providerTemplateSupport(undefined)).toEqual({ model: true, effort: true });
  });
});

function model(id: string, providers: string[], cost_tier: ModelCatalogEntry['cost_tier'], rank: number, extra: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id, label: id, family: 'x', providers, status: 'latest', cost_tier, rank,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'high', ...extra,
  };
}

describe('recommendations stay inside what the provider offers', () => {
  const catalog = {
    ...BUILTIN_MODEL_CATALOG,
    models: [
      model('gemini-2.5-pro', ['gemini_sub', 'gemini_http'], 'flagship', 2),
      model('gemini-3.5-flash', ['gemini_sub'], 'eco', 3),
      model('gemini-4-carbon', ['gemini_http'], 'flagship', 1),
      model('deepseek-v4.1-flash', ['dsh_opencode'], 'eco', 1),
      model('deepseek-v4-flash', ['dsh_deepseek'], 'eco', 2),
    ],
  };

  test('the served per-provider tier effort is the one used, the same value the server recommends', () => {
    const sonnet = model('claude-sonnet-5-5', ['claude_sub'], 'standard', 1, {
      provider_efforts: { claude_sub: ['low', 'medium', 'high'] }, effort_sources: { claude_sub: 'default' },
    });
    const served = {
      ...BUILTIN_MODEL_CATALOG,
      models: [sonnet],
      tier_recommendations: { ...BUILTIN_MODEL_CATALOG.tier_recommendations, L2: [
        { providers: ['claude_sub'], model: 'claude-sonnet-5-5', effort: 'max', note_en: '', note_zh: '',
          efforts_by_provider: { claude_sub: 'high' } },
      ] },
    };
    expect(recommendRoleSpec('critical_executor', ['claude_sub'], served))
      .toEqual({ provider: 'claude_sub', model: 'claude-sonnet-5-5', effort: 'high' });
  });

  test('a recommended model the CLI does not list falls back to the same tier in that provider', () => {
    expect(recommendRoleSpec('brainstorm_and_final_gate', ['agy_sub', 'gemini_sub', 'claude_sub'], BUILTIN_MODEL_CATALOG))
      .toEqual({ provider: 'agy_sub', model: 'gemini-4-carbon', effort: 'medium' });
    expect(recommendRoleSpec('brainstorm_and_final_gate', ['gemini_sub'], catalog))
      .toEqual({ provider: 'gemini_sub', model: 'gemini-2.5-pro', effort: 'medium' });
    expect(recommendRoleSpec('brainstorm_and_final_gate', ['gemini_http'], catalog))
      .toEqual({ provider: 'gemini_http', model: 'gemini-4-carbon', effort: 'medium' });
    expect(recommendRoleSpec('bulk_worker', ['dsh_deepseek'], catalog, 'dsh_deepseek'))
      .toEqual({ provider: 'dsh_deepseek', model: 'deepseek-v4-flash', effort: 'high' });
    expect(recommendRoleSpec('bulk_worker', ['dsh_opencode'], catalog))
      .toEqual({ provider: 'dsh_opencode', model: 'deepseek-v4.1-flash', effort: 'max' });
  });
});

describe('effort options', () => {
  const sol = model('gpt-6.2-sol', ['codex_sub', 'openai_http'], 'standard', 1, {
    provider_efforts: { codex_sub: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  });

  test('Codex models offer exactly the efforts Codex reports, including ultra', () => {
    const codex = effortOptionsFor(sol, 'codex_sub', BUILTIN_MODEL_CATALOG.efforts);
    expect(codex.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(codex.at(-1)).toEqual({ id: 'ultra', label: 'Ultra' });
    expect(effortOptionsFor(sol, 'openai_http', BUILTIN_MODEL_CATALOG.efforts).map((e) => e.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortOptionsFor(undefined, 'claude_sub', BUILTIN_MODEL_CATALOG.efforts)).toEqual(BUILTIN_MODEL_CATALOG.efforts);
  });

  test('an effort the chosen model does not offer is replaced by one it does', () => {
    const options = [{ id: 'low', label: 'Low' }, { id: 'max', label: 'Max' }];
    // Same rule as the server: the nearest offered level; on a tie the lower (cheaper) one.
    expect(coerceEffort('max', options, 'low')).toBe('max');
    expect(coerceEffort('ultra', options, 'low')).toBe('max');
    expect(coerceEffort('medium', options, 'max')).toBe('low');  // low and max: low is nearer
    expect(coerceEffort('medium', [{ id: 'low' }, { id: 'high' }], 'max')).toBe('low');  // tie -> lower
    expect(coerceEffort('turbo', options, 'max')).toBe('max');  // unknown level -> legal default
    expect(coerceEffort('high', [], 'medium')).toBe('');
  });

  test('server effort lists are used exactly; an empty list means no effort and the source is visible', () => {
    const flash = model('deepseek-v4.1-flash', ['dsh_opencode'], 'eco', 1, {
      provider_efforts: { dsh_opencode: ['low', 'high', 'max'] },
      provider_defaults: { dsh_opencode: 'max' },
      effort_sources: { dsh_opencode: 'cli_models' },
    });
    const pro = model('gemini-2.5-pro', ['gemini_sub'], 'flagship', 1, {
      provider_efforts: { gemini_sub: [] }, effort_sources: { gemini_sub: 'cli_declared' },
    });
    expect(effortOptionsFor(flash, 'dsh_opencode', BUILTIN_MODEL_CATALOG.efforts).map((e) => e.id)).toEqual(['low', 'high', 'max']);
    expect(effortOptionsFor(pro, 'gemini_sub', BUILTIN_MODEL_CATALOG.efforts)).toEqual([]);
    expect(normalizeRoleEffort('dsh_opencode', 'deepseek-v4.1-flash', 'medium', [flash])).toBe('low');  // tie -> lower
    expect(closestEffort('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
    expect(normalizeRoleEffort('gemini_sub', 'gemini-2.5-pro', 'high', [pro])).toBe('');
    expect(normalizeRoleEffort('claude_sub', 'claude-zeta', 'turbo', [flash, pro])).toBe('turbo');  // unknown: untouched
    expect(effortSourceFor(flash, 'dsh_opencode')).toBe('cli_models');
    expect(legalDefaultEffort('high', ['medium'])).toBe('medium');
    expect(legalDefaultEffort('low', ['high', 'max'])).toBe('high');
    expect(describeCorrections([{ role: 'bulk_worker', before: 'dsh_opencode:deepseek-v4.1-flash@medium',
      after: 'dsh_opencode:deepseek-v4.1-flash@low', reason: 'effort_adjusted' }], 'en')).toContain('Medium → Low');
  });
});

describe('saved lineup profiles & last-used restoration', () => {
  const baseline: RecommendedLineup = {
    ready: true,
    roles: {
      brainstorm_and_final_gate: 'agy_sub',
      tactical_planner: 'claude_sub',
      critical_executor: 'codex_sub',
    },
    model_overrides: {
      brainstorm_and_final_gate: 'agy_sub:gemini-4-carbon@medium',
      tactical_planner: 'claude_sub:claude-opus-5-5@medium',
      critical_executor: 'codex_sub:gpt-6.2-sol@max',
    },
    source: 'cli',
    notes_en: 'Ready.',
    notes_zh: '就绪。',
  };

  test('applySavedLineup keeps valid saved choices and falls back when a provider is unavailable', () => {
    const saved = {
      roles: {
        brainstorm_and_final_gate: 'claude_sub',
        tactical_planner: 'missing_cli',
        critical_executor: 'codex_sub',
      },
      model_overrides: {
        brainstorm_and_final_gate: 'claude_sub:claude-fable-5-2@medium',
        tactical_planner: 'missing_cli:some-model@high',
        critical_executor: 'codex_sub:gpt-6.2-astra@xhigh',
      },
    };
    const restored = applySavedLineup(baseline, saved, ['agy_sub', 'claude_sub', 'codex_sub'], BUILTIN_MODEL_CATALOG);
    expect(restored.roles).toEqual({
      brainstorm_and_final_gate: 'claude_sub',
      tactical_planner: 'claude_sub',
      critical_executor: 'codex_sub',
    });
    expect(restored.model_overrides).toEqual({
      brainstorm_and_final_gate: 'claude_sub:claude-fable-5-2@medium',
      tactical_planner: 'claude_sub:claude-opus-5-5@medium',
      critical_executor: 'codex_sub:gpt-6.2-astra@xhigh',
    });

    const profile = {
      id: 'p-1',
      name: 'My Mix',
      roles: restored.roles,
      model_overrides: restored.model_overrides ?? {},
      updated_at: 1,
    };
    expect(matchSavedProfile([profile], restored)?.id).toBe('p-1');
    expect(matchSavedProfile([profile], baseline)).toBeNull();
  });
});

type SetupListener = (event: { key?: string; target?: SetupNode }) => void;
interface SetupDocument {
  documentElement: { lang: string };
  title: string;
  createElement(tag: string): SetupNode;
  createElementNS(namespace: string, tag: string): SetupNode;
  createTextNode(text: string): SetupNode;
  addEventListener(type: string, listener: SetupListener): void;
  removeEventListener(type: string, listener: SetupListener): void;
}

// A small host DOM lets the actual component, effects and event handlers run in Vitest's node environment.
class SetupNode {
  readonly nodeType: number;
  readonly children: SetupNode[] = [];
  readonly style: Record<string, string | number> = {};
  readonly attrs = new Map<string, string>();
  parentNode: SetupNode | null = null;
  private content = '';
  private classValue = '';
  value = '';

  constructor(readonly tagName: string, readonly ownerDocument: SetupDocument, text = '') {
    this.nodeType = tagName === '#text' ? 3 : 1;
    this.content = text;
  }
  get className() { return this.classValue; }
  set className(value: string) { this.classValue = value; this.attrs.set('class', value); }
  get textContent(): string { return this.content + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.content = value; this.children.length = 0; }
  get nodeValue() { return this.content; }
  set nodeValue(value: string) { this.content = value; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); if (name === 'class') this.classValue = String(value); }
  removeAttribute(name: string) { this.attrs.delete(name); if (name === 'class') this.classValue = ''; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  appendChild(child: SetupNode) { this.insertBefore(child, null); }
  insertBefore(child: SetupNode, sibling: SetupNode | null) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = sibling ? this.children.indexOf(sibling) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentNode = this;
  }
  removeChild(child: SetupNode) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
  }
  contains(node: SetupNode): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  find(predicate: (node: SetupNode) => boolean): SetupNode | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match) return match;
    }
    return undefined;
  }
  reactProps(): Record<string, unknown> {
    const key = Object.keys(this).find((name) => name.startsWith('__reactProps$'));
    if (!key) throw new Error(`Missing React props for ${this.tagName}`);
    return (this as unknown as Record<string, Record<string, unknown>>)[key];
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const claudeDriver: CliDriver = {
  ...dsh, id: 'claude', name: 'Claude Code', binary: 'claude', provider_ids: ['claude_sub'],
  install_cmd: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
};
const repo: WorkspaceInfo = { path: '/repo', is_git_repo: true, branch: 'main', has_commits: true, has_rfc: false };
const sixRoles = {
  brainstorm_and_final_gate: 'claude_sub', tactical_planner: 'claude_sub', milestone_reviewer: 'claude_sub',
  critical_executor: 'claude_sub', micro_orchestrator: 'claude_sub', bulk_worker: 'claude_sub',
};
function scanResponse(statuses: [CliScanEntry['status'], CliScanEntry['status']]): CliRegistryScanResponse {
  const ready = statuses.includes('ready');
  return {
    scan: { drivers: [entry(statuses[0], 'dsh'), entry(statuses[1], 'claude')], http_api_keys_present: [], scanned_at: 1 },
    lineup: { ...lineup(ready), roles: ready ? sixRoles : {} },
  };
}
function setupApi(statuses: [CliScanEntry['status'], CliScanEntry['status']]) {
  return {
    getWorkspaceInfo: vi.fn().mockResolvedValue(repo),
    selectWorkspace: vi.fn(async (path: string) => ({ ...repo, path })),
    initGitWorkspace: vi.fn().mockResolvedValue({ ...repo, created: true }),
    getCliRegistry: vi.fn().mockResolvedValue({ schema_version: 1, drivers: [dsh, claudeDriver], tags: [] }),
    scanCliRegistry: vi.fn().mockResolvedValue(scanResponse(statuses)),
    installCli: vi.fn().mockResolvedValue({ id: 'dsh', ok: true, command: dsh.install_cmd, returncode: 0, output: '' }),
    loginCli: vi.fn().mockResolvedValue({ id: 'dsh', launched: true, command: ['dsh'], message_en: 'Sign in', message_zh: '登录' }),
  };
}

let setupRoot: Root | undefined;
async function mountSetup(api: ReturnType<typeof setupApi>, onReady = vi.fn(), extra: Partial<GuidedSetupStepProps> = {}, strict = false) {
  const windowListeners = new Map<string, Set<SetupListener>>();
  const documentListeners = new Map<string, Set<SetupListener>>();
  const documentObj: SetupDocument = {
    documentElement: { lang: '' }, title: '',
    createElement: (tag) => new SetupNode(tag, documentObj),
    createElementNS: (_namespace, tag) => new SetupNode(tag, documentObj),
    createTextNode: (text) => new SetupNode('#text', documentObj, text),
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? new Set<SetupListener>();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
  };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', documentObj);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => 'en' },
    addEventListener(type: string, listener: SetupListener) {
      const listeners = windowListeners.get(type) ?? new Set<SetupListener>();
      listeners.add(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: SetupListener) { windowListeners.get(type)?.delete(listener); },
  });
  const container = new SetupNode('DIV', documentObj);
  setupRoot = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    const content = createElement(I18nProvider, {
      children: createElement(GuidedSetupStep, { ...extra, locale: 'en', api, onReady }),
    });
    setupRoot!.render(strict ? createElement(StrictMode, null, content) : content);
  });
  function button(label: string, within: SetupNode = container): SetupNode {
    const node = within.find((item) => item.tagName === 'button' && item.textContent === label);
    if (!node) throw new Error(`Missing button ${label}; rendered: ${within.textContent}`);
    return node;
  }
  async function click(node: SetupNode) {
    const props = node.reactProps();
    expect(props.disabled).not.toBe(true);
    await act(async () => { (props.onClick as (event: object) => void)({ currentTarget: node }); });
  }
  return {
    container, button, click, onReady,
    focus() { for (const listener of windowListeners.get('focus') ?? []) listener({}); },
    focusListenerCount() { return windowListeners.get('focus')?.size ?? 0; },
    async unmount() { await act(async () => { setupRoot?.unmount(); }); setupRoot = undefined; },
  };
}

afterEach(() => {
  if (setupRoot) act(() => setupRoot?.unmount());
  setupRoot = undefined;
  vi.unstubAllGlobals();
});

describe('GuidedSetupStep interactions', () => {
  test('keeps cards expanded with no ready CLI, and shows no role lineup table', async () => {
    const api = setupApi(['missing', 'installed_unauthenticated']);
    const screen = await mountSetup(api);
    expect(screen.container.find((node) => node.className === 'guided-setup__drivers')).toBeDefined();
    expect(screen.container.find((node) => node.className === 'cli-summary-bar')).toBeUndefined();
    expect(screen.container.find((node) => node.className === 'guided-setup__role-grid' || node.tagName === 'table')).toBeUndefined();
    expect(screen.container.textContent).not.toContain(MESSAGES.en.guided.setup.customizeRoles);
  });

  test('one ready CLI collapses cards, opens on demand and can collapse again', async () => {
    const api = setupApi(['missing', 'ready']);
    const screen = await mountSetup(api);
    expect(screen.container.find((node) => node.className === 'cli-summary-bar')).toBeDefined();
    expect(screen.container.find((node) => node.className === 'guided-setup__drivers')).toBeUndefined();
    expect(screen.container.find((node) => node.className === 'guided-setup__role-grid' || node.tagName === 'table')).toBeUndefined();
    await screen.click(screen.button(MESSAGES.en.guided.m3.cliSummary.details));
    expect(screen.container.find((node) => node.className === 'guided-setup__drivers')).toBeDefined();
    await screen.click(screen.button(MESSAGES.en.glossary.close));
    expect(screen.container.find((node) => node.className === 'guided-setup__drivers')).toBeUndefined();
    expect(screen.container.textContent).not.toContain(MESSAGES.en.guided.setup.customizeRoles);
  });

  test('confirmation is required; a successful install highlights Sign In without starting login', async () => {
    const api = setupApi(['missing', 'missing']);
    const install = deferred<CliInstallResult>();
    api.installCli.mockReturnValue(install.promise);
    const screen = await mountSetup(api);
    const card = screen.container.find((node) => node.className === 'guided-setup__driver' && node.textContent.includes('DSH'))!;
    await screen.click(screen.button('Install', card));
    let dialog = card.find((node) => node.getAttribute('role') === 'dialog')!;
    expect(dialog.textContent).toContain('npm install -g @deepseek-ai/dsh');
    expect(api.installCli).not.toHaveBeenCalled();
    await screen.click(screen.button(MESSAGES.en.guided.m3.installConfirm.cancel, dialog));
    expect(api.installCli).not.toHaveBeenCalled();
    await screen.click(screen.button('Install', card));
    dialog = card.find((node) => node.getAttribute('role') === 'dialog')!;
    const confirm = screen.button(MESSAGES.en.guided.m3.installConfirm.confirm, dialog);
    const onConfirm = confirm.reactProps().onClick as (event: object) => void;
    await act(async () => { onConfirm({}); onConfirm({}); });
    expect(api.installCli).toHaveBeenCalledExactlyOnceWith({ cliId: 'dsh', confirmed: true });
    expect(api.loginCli).not.toHaveBeenCalled();
    await act(async () => { install.resolve({ id: 'dsh', ok: true, command: dsh.install_cmd, returncode: 0, output: '' }); });
    const signIn = screen.button(MESSAGES.en.guided.setup.login, card);
    expect(signIn.className).toContain('guided-setup__button--sign-in');
    expect(card.find((node) => node.getAttribute('role') === 'dialog')).toBeUndefined();
    expect(api.loginCli).not.toHaveBeenCalled();
    await screen.click(signIn);
    expect(api.loginCli).toHaveBeenCalledExactlyOnceWith('dsh');
  });

  test('installing from expanded details keeps the highlighted sign-in visible when another CLI is ready', async () => {
    const api = setupApi(['missing', 'ready']);
    const screen = await mountSetup(api);
    await screen.click(screen.button(MESSAGES.en.guided.m3.cliSummary.details));
    const card = screen.container.find((node) => node.className === 'guided-setup__driver' && node.textContent.includes('DSH'))!;
    await screen.click(screen.button('Install', card));
    const dialog = card.find((node) => node.getAttribute('role') === 'dialog')!;
    await screen.click(screen.button('Install', dialog));
    expect(screen.button(MESSAGES.en.guided.setup.login, card).className).toContain('guided-setup__button--sign-in');
    expect(api.loginCli).not.toHaveBeenCalled();
  });

  test('a failed sign-in launch keeps the post-install action highlighted for retry', async () => {
    const api = setupApi(['missing', 'missing']);
    api.loginCli.mockResolvedValue({ id: 'dsh', launched: false, command: [], message_en: 'Unavailable', message_zh: '' });
    const screen = await mountSetup(api);
    const card = screen.container.find((node) => node.className === 'guided-setup__driver' && node.textContent.includes('DSH'))!;
    await screen.click(screen.button('Install', card));
    const dialog = card.find((node) => node.getAttribute('role') === 'dialog')!;
    await screen.click(screen.button('Install', dialog));
    await screen.click(screen.button(MESSAGES.en.guided.setup.login, card));
    expect(screen.button(MESSAGES.en.guided.setup.login, card).className).toContain('guided-setup__button--sign-in');
    await act(async () => screen.focus());
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(1);
  });

  test('failed installation stays in the popover and does not offer sign-in', async () => {
    const api = setupApi(['missing', 'missing']);
    api.installCli.mockResolvedValue({ id: 'dsh', ok: false, command: dsh.install_cmd, returncode: 1, output: 'Install failed' });
    const screen = await mountSetup(api);
    const card = screen.container.find((node) => node.className === 'guided-setup__driver' && node.textContent.includes('DSH'))!;
    await screen.click(screen.button('Install', card));
    const dialog = card.find((node) => node.getAttribute('role') === 'dialog')!;
    await screen.click(screen.button('Install', dialog));
    expect(dialog.textContent).toContain('Install failed');
    expect(card.textContent).not.toContain(MESSAGES.en.guided.setup.login);
    expect(api.loginCli).not.toHaveBeenCalled();
  });

  test('focus after sign-in starts exactly one rescan, with no listener after unmount', async () => {
    const api = setupApi(['installed_unauthenticated', 'missing']);
    const screen = await mountSetup(api);
    expect(screen.focusListenerCount()).toBe(1);
    await act(async () => screen.focus());
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(1);
    await screen.click(screen.button(MESSAGES.en.guided.setup.login));
    const scan = deferred<CliRegistryScanResponse>();
    api.scanCliRegistry.mockReturnValueOnce(scan.promise);
    await act(async () => { screen.focus(); screen.focus(); });
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
    await act(async () => { scan.resolve(scanResponse(['ready', 'missing'])); });
    await act(async () => screen.focus());
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
    expect(screen.container.find((node) => node.className === 'cli-summary-bar')).toBeDefined();
    await screen.unmount();
    expect(screen.focusListenerCount()).toBe(0);
    screen.focus();
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
  });

  test('returns to scanning on each later focus until sign-in is ready', async () => {
    const api = setupApi(['installed_unauthenticated', 'missing']);
    const screen = await mountSetup(api);
    await screen.click(screen.button(MESSAGES.en.guided.setup.login));
    await act(async () => screen.focus());
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
    api.scanCliRegistry.mockResolvedValueOnce(scanResponse(['ready', 'missing']));
    await act(async () => screen.focus());
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(3);
    await act(async () => screen.focus());
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(3);
  });

  test('StrictMode leaves one focus listener and removes it on unmount', async () => {
    const api = setupApi(['installed_unauthenticated', 'missing']);
    const screen = await mountSetup(api, vi.fn(), {}, true);
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(1);
    expect(screen.focusListenerCount()).toBe(1);
    await screen.click(screen.button(MESSAGES.en.guided.setup.login));
    await act(async () => screen.focus());
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
    await screen.unmount();
    expect(screen.focusListenerCount()).toBe(0);
  });

  test('a focus while login is starting waits for launch and shares any in-flight scan', async () => {
    const api = setupApi(['installed_unauthenticated', 'missing']);
    const login = deferred<CliLoginResult>();
    api.loginCli.mockReturnValue(login.promise);
    const screen = await mountSetup(api);
    await screen.click(screen.button(MESSAGES.en.guided.setup.login));
    await act(async () => { screen.focus(); screen.focus(); });
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(1);
    const scan = deferred<CliRegistryScanResponse>();
    api.scanCliRegistry.mockReturnValueOnce(scan.promise);
    await act(async () => { login.resolve({ id: 'dsh', launched: true, command: ['dsh'], message_en: '', message_zh: '' }); });
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
    await act(async () => { screen.focus(); scan.resolve(scanResponse(['ready', 'missing'])); });
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
  });
});

function sessionFor(path: string, draft: string): GuidedSession {
  return {
    schema_version: 1, active_stage: 'setup', workspace_path: path,
    brainstorm: { messages: [], checklist: [], latest_rfc_draft: draft, selected_l0_model: null, has_online_draft: Boolean(draft) },
    workflow: { mode: null, lineup: { roles: {}, model_overrides: {} }, preset: null, panel_enabled: false, launch_request_id: null },
    active_run_id: null, open_human_gate: null, open_drawer: null,
  };
}

function sessionBackedApi() {
  const api = setupApi(['missing', 'ready']);
  let currentPath = '/repo';
  const sessions = new Map<string, GuidedSession>([
    ['/repo', sessionFor('/repo', '# Old draft')],
    ['/next', sessionFor('/next', '# Existing next draft')],
  ]);
  const calls: string[] = [];
  const client = Object.assign(api, {
    getGuidedSession: vi.fn(async () => structuredClone(sessions.get(currentPath)!)),
    saveGuidedSession: vi.fn(async (patch: GuidedSessionPatch) => {
      calls.push(`save:${currentPath}:${patch.workspace_path}`);
      const saved = { ...sessions.get(currentPath)!, ...patch } as GuidedSession;
      sessions.set(currentPath, saved);
      return structuredClone(saved);
    }),
    resetGuidedSession: vi.fn(async () => structuredClone(sessions.get(currentPath)!)),
    browseWorkspace: vi.fn(async () => {
      calls.push('browse');
      currentPath = '/next';
      return { cancelled: false, path: currentPath, workspace: { ...repo, path: currentPath } };
    }),
  });
  client.selectWorkspace.mockImplementation(async (path) => {
    calls.push(`select:${path}`);
    currentPath = path;
    return { ...repo, path };
  });
  return { client, sessions, calls };
}

describe('GuidedSetupStep workspace and scan coordination', () => {
  test('Git initialization unlocks continuing once the workspace has a first commit', async () => {
    const api = setupApi(['missing', 'ready']);
    api.getWorkspaceInfo.mockResolvedValueOnce({ ...repo, is_git_repo: false, branch: null, has_commits: false });
    const screen = await mountSetup(api);
    expect(screen.button(MESSAGES.en.guided.setup.useLineup).reactProps().disabled).toBe(true);
    await screen.click(screen.button(MESSAGES.en.guided.setup.initGit));
    expect(api.initGitWorkspace).toHaveBeenCalledOnce();
    expect(screen.button(MESSAGES.en.guided.setup.useLineup).reactProps().disabled).toBe(false);
  });

  test('preserves the existing initial role and model overrides when continuing', async () => {
    const api = setupApi(['ready', 'ready']);
    const onReady = vi.fn();
    const screen = await mountSetup(api, onReady, {
      initialRoles: { tactical_planner: 'dsh_opencode' },
      initialModelOverrides: { tactical_planner: 'dsh_opencode:deepseek-v4.1-flash@max' },
    });
    await screen.click(screen.button(MESSAGES.en.guided.setup.useLineup));
    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady.mock.calls[0][0]).toMatchObject({
      roles: { tactical_planner: 'dsh_opencode' },
      model_overrides: { tactical_planner: 'dsh_opencode:deepseek-v4.1-flash@max' },
    });
  });

  test('persists a browsed workspace through the session before continuing, preserving both drafts', async () => {
    const { client, sessions, calls } = sessionBackedApi();
    const screen = await mountSetup(client);
    await screen.click(screen.button(MESSAGES.en.guided.setup.pickFolder));
    expect(calls).toEqual(['browse', 'save:/next:/next']);
    expect(sessions.get('/repo')?.brainstorm.latest_rfc_draft).toBe('# Old draft');
    expect(sessions.get('/next')?.brainstorm.latest_rfc_draft).toBe('# Existing next draft');
    expect(sessions.get('/next')?.workspace_path).toBe('/next');
    await screen.click(screen.button(MESSAGES.en.guided.setup.useLineup));
    expect(screen.onReady).toHaveBeenCalledOnce();
    expect(sessions.get('/next')?.workspace_path).toBe('/next');
  });

  test('a workspace save failure blocks continuing and can be retried without discarding the destination draft', async () => {
    const { client, sessions } = sessionBackedApi();
    client.saveGuidedSession.mockRejectedValueOnce(new Error('Cannot save workspace'));
    const screen = await mountSetup(client);
    await screen.click(screen.button(MESSAGES.en.guided.setup.pickFolder));
    expect(screen.container.textContent).toContain('Cannot save workspace');
    expect(screen.onReady).not.toHaveBeenCalled();
    expect(screen.container.textContent).not.toContain(MESSAGES.en.guided.setup.useLineup);
    await screen.click(screen.button(MESSAGES.en.guided.setup.applyPath));
    expect(sessions.get('/next')?.brainstorm.latest_rfc_draft).toBe('# Existing next draft');
    expect(sessions.get('/next')?.workspace_path).toBe('/next');
    await screen.click(screen.button(MESSAGES.en.guided.setup.useLineup));
    expect(screen.onReady).toHaveBeenCalledOnce();
  });

  test('a supplied parent session flushes queued writes before switching and reports the persisted workspace', async () => {
    const { client } = sessionBackedApi();
    const events: string[] = [];
    const parentSession = {
      session: sessionFor('/repo', '# Old draft'), loading: false, saving: false, error: null,
      save: vi.fn((patch: GuidedSessionPatch) => { events.push(`save:${patch.workspace_path}`); }),
      flush: vi.fn(async () => { events.push('flush'); return sessionFor('/repo', '# Old draft'); }),
      reset: vi.fn(async () => sessionFor('/repo', '')),
      ensureLaunchRequestId: vi.fn(async () => 'request-id'),
    };
    client.browseWorkspace.mockImplementation(async () => {
      events.push('browse');
      return { cancelled: false, path: '/next', workspace: { ...repo, path: '/next' } };
    });
    const screen = await mountSetup(client, vi.fn(), {
      guidedSession: parentSession,
      onWorkspaceChanged: (info) => events.push(`changed:${info.path}`),
    });
    expect(client.getGuidedSession).not.toHaveBeenCalled();
    await screen.click(screen.button(MESSAGES.en.guided.setup.pickFolder));
    expect(events).toEqual(['flush', 'browse', 'save:/next', 'flush', 'changed:/next']);
  });

  test('a manual rescan and the sign-in focus share the same in-flight request', async () => {
    const api = setupApi(['installed_unauthenticated', 'missing']);
    const screen = await mountSetup(api);
    await screen.click(screen.button(MESSAGES.en.guided.setup.login));
    const scan = deferred<CliRegistryScanResponse>();
    api.scanCliRegistry.mockReturnValueOnce(scan.promise);
    await screen.click(screen.button(MESSAGES.en.guided.setup.scanClis));
    await act(async () => { screen.focus(); screen.focus(); });
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
    await act(async () => { scan.resolve(scanResponse(['ready', 'missing'])); });
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
  });

  test('a scan from the previous workspace cannot overwrite the new workspace scan', async () => {
    const api = setupApi(['installed_unauthenticated', 'missing']);
    const selection = deferred<WorkspaceInfo>();
    api.selectWorkspace.mockReturnValueOnce(selection.promise);
    const screen = await mountSetup(api);
    await screen.click(screen.button(MESSAGES.en.guided.setup.login));
    const input = screen.container.find((node) => node.tagName === 'input'
      && node.reactProps()['aria-label'] === MESSAGES.en.guided.setup.currentFolder)!;
    await act(async () => { (input.reactProps().onChange as (event: object) => void)({ target: { value: '/next' } }); });
    await screen.click(screen.button(MESSAGES.en.guided.setup.applyPath));
    const oldScan = deferred<CliRegistryScanResponse>();
    api.scanCliRegistry.mockReturnValueOnce(oldScan.promise).mockResolvedValueOnce(scanResponse(['missing', 'missing']));
    await act(async () => screen.focus());
    await act(async () => { selection.resolve({ ...repo, path: '/next' }); });
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(3);
    await act(async () => { oldScan.resolve(scanResponse(['ready', 'missing'])); });
    expect(screen.container.find((node) => node.className === 'cli-summary-bar')).toBeUndefined();
    expect(screen.container.find((node) => node.className === 'guided-setup__drivers')).toBeDefined();
  });

  test('reselecting the same path starts a fresh scan after invalidating the old one', async () => {
    const api = setupApi(['installed_unauthenticated', 'missing']);
    const selection = deferred<WorkspaceInfo>();
    api.selectWorkspace.mockReturnValueOnce(selection.promise);
    const screen = await mountSetup(api);
    await screen.click(screen.button(MESSAGES.en.guided.setup.login));
    await screen.click(screen.button(MESSAGES.en.guided.setup.applyPath));
    const oldScan = deferred<CliRegistryScanResponse>();
    api.scanCliRegistry.mockReturnValueOnce(oldScan.promise).mockResolvedValueOnce(scanResponse(['missing', 'ready']));
    await act(async () => screen.focus());
    await act(async () => { selection.resolve(repo); });
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(3);
    expect(screen.container.find((node) => node.className === 'cli-summary-bar')).toBeDefined();
    await act(async () => { oldScan.resolve(scanResponse(['missing', 'missing'])); });
    expect(screen.container.find((node) => node.className === 'cli-summary-bar')).toBeDefined();
  });

  test('a sign-in that does not launch does not schedule a focus rescan', async () => {
    const api = setupApi(['installed_unauthenticated', 'missing']);
    api.loginCli.mockResolvedValue({ id: 'dsh', launched: false, command: [], message_en: 'Unavailable', message_zh: '' });
    const screen = await mountSetup(api);
    await screen.click(screen.button(MESSAGES.en.guided.setup.login));
    await act(async () => screen.focus());
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(1);
  });
});

describe('workspaceReadiness', () => {
  const scanned = scanResponse(['missing', 'ready']);
  const input = (overrides: Partial<SetupReadinessInput> = {}): SetupReadinessInput => ({
    workspace: repo, drivers: [dsh, claudeDriver], scan: scanned.scan, recommended: scanned.lineup, ...overrides,
  });

  test('has no verdict until both the folder and the tool scan are known', () => {
    expect(workspaceReadiness(input({ workspace: null }))).toBeNull();
    expect(workspaceReadiness(input({ scan: null }))).toBeNull();
    expect(workspaceReadiness(input({ recommended: null }))).toBeNull();
  });

  test('ready: the folder has Git history and every tool the team uses is ready', () => {
    expect(workspaceReadiness(input())).toEqual({ state: 'ready', reasons: [] });
    expect(workspaceReadiness(input(), { critical_executor: 'claude_sub' })).toEqual({ state: 'ready', reasons: [] });
    // An empty team falls back to the recommended one.
    expect(workspaceReadiness(input(), {})).toEqual({ state: 'ready', reasons: [] });
  });

  test('blocked: no Git, no first save point, or no team that can run at all', () => {
    expect(workspaceReadiness(input({ workspace: { ...repo, is_git_repo: false, branch: null, has_commits: false } })))
      .toEqual({ state: 'blocked', reasons: [{ code: 'no_git' }] });
    const nothing = scanResponse(['missing', 'installed_unauthenticated']);
    expect(workspaceReadiness(input({ workspace: { ...repo, has_commits: false }, scan: nothing.scan, recommended: nothing.lineup })))
      .toEqual({ state: 'blocked', reasons: [{ code: 'no_commits' }, { code: 'no_team' }] });
  });

  test('partly ready: a team can run, but a tool the chosen team uses is not ready', () => {
    expect(workspaceReadiness(input(), { tactical_planner: 'dsh_opencode', critical_executor: 'claude_sub' }))
      .toEqual({ state: 'partial', reasons: [{ code: 'tools_unavailable', providers: ['dsh_opencode'] }] });
  });
});

describe('GuidedSetupStep readiness for the workbench', () => {
  test('reports what readiness is computed from, and Continue follows the same verdict', async () => {
    const api = setupApi(['missing', 'ready']);
    api.getWorkspaceInfo.mockResolvedValueOnce({ ...repo, has_commits: false });
    const reports: SetupReadinessReport[] = [];
    const screen = await mountSetup(api, vi.fn(), { onReadiness: (report) => { reports.push(report); } });
    const first = reports.at(-1)!;
    expect(first.checking).toBe(false);
    expect(workspaceReadiness(first.input)).toEqual({ state: 'blocked', reasons: [{ code: 'no_commits' }] });
    expect(screen.button(MESSAGES.en.guided.setup.useLineup).reactProps().disabled).toBe(true);

    let fresh: SetupReadinessInput | null = null;
    await act(async () => { fresh = await first.recheck(); });
    expect(api.getWorkspaceInfo).toHaveBeenCalledTimes(2);
    expect(api.scanCliRegistry).toHaveBeenCalledTimes(2);
    expect(workspaceReadiness(fresh!)).toEqual({ state: 'ready', reasons: [] });
    expect(workspaceReadiness(reports.at(-1)!.input)).toEqual({ state: 'ready', reasons: [] });
    expect(screen.button(MESSAGES.en.guided.setup.useLineup).reactProps().disabled).toBe(false);
  });

  test('reports checking until the first load has read the folder, so nothing looks like a failed check', async () => {
    const api = setupApi(['missing', 'ready']);
    const info = deferred<WorkspaceInfo>();
    api.getWorkspaceInfo.mockReturnValueOnce(info.promise);
    const reports: SetupReadinessReport[] = [];
    await mountSetup(api, vi.fn(), { onReadiness: (report) => { reports.push(report); } });
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((report) => report.checking)).toBe(true);
    await act(async () => { info.resolve(repo); });
    expect(reports.at(-1)!.checking).toBe(false);
    expect(workspaceReadiness(reports.at(-1)!.input)?.state).toBe('ready');
  });

  test('a failed first load is reported as done, with no verdict', async () => {
    const api = setupApi(['missing', 'ready']);
    api.getCliRegistry.mockRejectedValueOnce(new Error('Registry unavailable'));
    const reports: SetupReadinessReport[] = [];
    await mountSetup(api, vi.fn(), { onReadiness: (report) => { reports.push(report); } });
    expect(reports.at(-1)!.checking).toBe(false);
    expect(workspaceReadiness(reports.at(-1)!.input)).toBeNull();
  });

  test('a failed check resolves with no input and shows the error in the wizard', async () => {
    const api = setupApi(['missing', 'ready']);
    const reports: SetupReadinessReport[] = [];
    const screen = await mountSetup(api, vi.fn(), { onReadiness: (report) => { reports.push(report); } });
    api.scanCliRegistry.mockRejectedValueOnce(new Error('Scan unavailable'));
    let fresh: SetupReadinessInput | null | undefined;
    await act(async () => { fresh = await reports.at(-1)!.recheck(); });
    expect(fresh).toBeNull();
    expect(screen.container.textContent).toContain('Scan unavailable');
  });

  test('continues on its own once ready when asked, saving the last-used team exactly as a click does', async () => {
    const withLastUsed = () => Object.assign(setupApi(['missing', 'ready']), {
      saveLastUsedLineup: vi.fn(async () => ({ profiles: [], last_used: null })),
    });
    const auto = withLastUsed();
    const autoReady = vi.fn();
    const autoScreen = await mountSetup(auto, autoReady, { autoContinue: true });
    expect(autoReady).toHaveBeenCalledOnce();
    expect(auto.saveLastUsedLineup).toHaveBeenCalledOnce();
    await autoScreen.unmount();

    const manual = withLastUsed();
    const manualReady = vi.fn();
    const manualScreen = await mountSetup(manual, manualReady);
    expect(manualReady).not.toHaveBeenCalled();
    await manualScreen.click(manualScreen.button(MESSAGES.en.guided.setup.useLineup));
    expect(manualReady).toHaveBeenCalledOnce();
    expect(manual.saveLastUsedLineup).toHaveBeenCalledOnce();
    expect(autoReady.mock.calls[0][0]).toEqual(manualReady.mock.calls[0][0]);
  });

  test('the button that hands the team on takes another label when the wizard is opened over a stage', async () => {
    const onReady = vi.fn();
    const screen = await mountSetup(setupApi(['missing', 'ready']), onReady, { continueLabel: 'Done' });
    expect(screen.container.textContent).not.toContain(MESSAGES.en.guided.setup.useLineup);
    await screen.click(screen.button('Done'));
    expect(onReady).toHaveBeenCalledOnce();
  });

  test('does not continue on its own while something is missing', async () => {
    const noTeam = vi.fn();
    const noTeamScreen = await mountSetup(setupApi(['missing', 'missing']), noTeam, { autoContinue: true });
    expect(noTeam).not.toHaveBeenCalled();
    await noTeamScreen.unmount();

    const api = setupApi(['missing', 'ready']);
    api.getWorkspaceInfo.mockResolvedValue({ ...repo, is_git_repo: false, branch: null, has_commits: false });
    const noGit = vi.fn();
    await mountSetup(api, noGit, { autoContinue: true });
    expect(noGit).not.toHaveBeenCalled();
  });
});
