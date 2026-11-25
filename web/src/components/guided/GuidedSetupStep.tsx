import './GuidedSetupStep.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BatonApiClient,
  type ApiMode,
  type CliDriver,
  type CliLoginResult,
  type CliScanEntry,
  type RecommendedLineup,
  type WorkspaceInfo,
} from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatProviderDisplay, translateRole } from '../../i18n/presets';
import { localizeGuidedError } from './guidedErrors';

/** The client methods this step needs; inject a fake in tests. */
export type GuidedSetupApi = Pick<
  BatonApiClient,
  'getWorkspaceInfo' | 'selectWorkspace' | 'initGitWorkspace' | 'getCliRegistry' | 'scanCliRegistry' | 'installCli' | 'loginCli'
> & Partial<Pick<BatonApiClient, 'browseWorkspace' | 'getRoles'>>;

let defaultApi: GuidedSetupApi | null = null;
function getDefaultApi(): GuidedSetupApi {
  return (defaultApi ??= new BatonApiClient());
}

const DSH_TEXT_RE = /\bdsh_(?:opencode|deepseek)\b/gi;

export type DriverFilter = 'all' | 'ready' | 'needs_setup';

/** Registry `name` for display; the dsh driver is always shown as `DSH`, never its backend wiring. */
export function driverDisplayName(driver: Pick<CliDriver, 'id' | 'name'>): string {
  if (driver.id === 'dsh') return 'DSH';
  return driver.name.trim() || driver.id;
}

/** Free text shown in a driver row; for dsh, any text mentioning its OpenCode backend is dropped. */
function driverText(driver: Pick<CliDriver, 'id'>, text: string): string {
  const scrubbed = text.replace(DSH_TEXT_RE, 'DSH');
  return driver.id === 'dsh' && /opencode/i.test(scrubbed) ? '' : scrubbed;
}

/** Filter registry drivers by scan status for quick triage in Guided Setup. */
export function filterDrivers(
  drivers: readonly CliDriver[],
  entries: Record<string, CliScanEntry>,
  filter: DriverFilter,
): CliDriver[] {
  if (filter === 'all') return [...drivers];
  if (filter === 'ready') return drivers.filter((driver) => entries[driver.id]?.status === 'ready');
  return drivers.filter((driver) => entries[driver.id]?.status !== 'ready');
}

/** Collect selectable ready/configured provider IDs for team role customization. */
export function availableLineupProviders(
  lineup: RecommendedLineup | null,
  drivers: readonly CliDriver[],
  entries: Record<string, CliScanEntry>,
  configuredProviders?: readonly string[],
): string[] {
  const activeRoleProviders = new Set(Object.values(lineup?.roles ?? {}));
  const result = new Set<string>(activeRoleProviders);
  const configured = configuredProviders ? new Set(configuredProviders) : null;

  for (const driver of drivers) {
    if (entries[driver.id]?.status !== 'ready') continue;
    for (const pid of driver.provider_ids) {
      if (configured && !configured.has(pid)) continue;
      if (pid.endsWith('_http') && !activeRoleProviders.has(pid)) continue;
      if (pid === 'dsh_opencode' && driver.id !== 'dsh') continue;
      result.add(pid);
    }
  }
  return [...result];
}

/** Build a new lineup assigning every role to a single chosen provider. */
export function assignAllRoles(lineup: RecommendedLineup, providerId: string): RecommendedLineup {
  const roles = Object.fromEntries(Object.keys(lineup.roles).map((role) => [role, providerId]));
  return { ...lineup, roles };
}

/** Build a new lineup overriding one role's provider without mutating the input. */
export function assignRoleProvider(
  lineup: RecommendedLineup,
  role: string,
  providerId: string,
): RecommendedLineup {
  return { ...lineup, roles: { ...lineup.roles, [role]: providerId } };
}

/** True when any role provider differs from the server-recommended baseline lineup. */
export function isLineupCustomized(
  base: RecommendedLineup | null,
  current: RecommendedLineup | null,
): boolean {
  if (!base || !current) return false;
  return Object.keys(base.roles).some((role) => base.roles[role] !== current.roles[role]);
}

/** One line listing who plays each role, e.g. `Planner: DSH, Coder: claude_sub`; falls back to the notes. */
export function lineupSummary(lineup: RecommendedLineup, locale: Locale): string {
  const roles = Object.entries(lineup.roles).map(
    ([role, provider]) => `${translateRole(role, locale)}: ${formatProviderDisplay(provider)}`,
  );
  if (roles.length === 0) return lineupNotes(lineup, locale);
  return roles.join(locale === 'zh' ? '，' : ', ');
}

function lineupNotes(lineup: RecommendedLineup, locale: Locale): string {
  return (locale === 'zh' ? lineup.notes_zh : lineup.notes_en).replace(DSH_TEXT_RE, 'DSH');
}

/** Install is offered only for a missing CLI, and only after the user ticked the consent box. */
export function canInstall(entry: Pick<CliScanEntry, 'status'> | undefined, consent: boolean): boolean {
  return consent === true && entry?.status === 'missing';
}

/** Runs the install recipe only when `canInstall` allows it; returns whether the API was called and succeeded. */
export async function installWithConsent(
  api: Pick<GuidedSetupApi, 'installCli'>,
  entry: CliScanEntry | undefined,
  consent: boolean,
): Promise<boolean> {
  if (!entry || !canInstall(entry, consent)) return false;
  const result = await api.installCli({ cliId: entry.id, confirmed: true });
  if (!result.ok) {
    throw new Error(result.output.trim() || `Install failed (exit ${result.returncode})`);
  }
  return true;
}

/** Turns on Git for the current workspace, then re-reads the workspace info. */
export async function initGitAndRefresh(
  api: Pick<GuidedSetupApi, 'initGitWorkspace' | 'getWorkspaceInfo'>,
): Promise<WorkspaceInfo> {
  await api.initGitWorkspace();
  return api.getWorkspaceInfo();
}

/** Hands the lineup to the next step only when it is ready; returns whether `onReady` fired. */
export function confirmLineup(lineup: RecommendedLineup | null, onReady: (lineup: RecommendedLineup) => void): boolean {
  if (!lineup?.ready) return false;
  onReady(lineup);
  return true;
}

function errorText(error: unknown, locale: Locale): string {
  return localizeGuidedError(error, locale);
}

export interface GuidedDriverRowProps {
  locale: Locale;
  driver: CliDriver;
  entry: CliScanEntry | undefined;
  consent: boolean;
  busy: boolean;
  activeAction?: string | null;
  feedback?: string | null;
  login: CliLoginResult | null;
  onConsentChange(consent: boolean): void;
  onInstall(): void;
  onLogin(): void;
}

/** One toolkit row: name, tier badge, status pill, diagnostics, and action. */
export function GuidedDriverRow({
  locale, driver, entry, consent, busy, activeAction = null, feedback = null, login, onConsentChange, onInstall, onLogin,
}: GuidedDriverRowProps) {
  const copy = MESSAGES[locale].guided.setup;
  const status = entry?.status ?? 'missing';
  const reason = entry ? driverText(driver, locale === 'zh' ? entry.reason_zh : entry.reason_en) : '';
  const summary = driverText(driver, locale === 'zh' ? driver.summary_zh : driver.summary_en);
  const tierLabel = copy.tiers[driver.tier as keyof typeof copy.tiers] ?? driver.tier;
  const pill = status === 'ready' ? copy.ready : status === 'installed_unauthenticated' ? copy.needsLogin : copy.missing;
  const loginNote = login ? driverText(driver, locale === 'zh' ? login.message_zh : login.message_en) : '';
  const isInstalling = activeAction === `install:${driver.id}`;
  const isLoggingIn = activeAction === `login:${driver.id}`;

  return (
    <li className="guided-setup__driver" data-status={status}>
      <div className="guided-setup__driver-head">
        <span className="guided-setup__driver-name">{driverDisplayName(driver)}</span>
        <span className="guided-setup__tier" data-tier={driver.tier}>{tierLabel}</span>
        <span className="guided-setup__pill" data-status={status}>{pill}</span>
        {entry?.version ? <span className="guided-setup__version">{entry.version}</span> : null}
      </div>
      {status === 'ready' && (entry?.binary_path || summary) ? (
        <div className="guided-setup__meta">
          {summary ? <p className="guided-setup__reason">{summary}</p> : null}
          {entry?.binary_path ? <code className="guided-setup__binary">{entry.binary_path}</code> : null}
        </div>
      ) : null}
      {status !== 'ready' && reason ? <p className="guided-setup__reason">{reason}</p> : null}
      {status === 'missing' ? (
        <div className="guided-setup__actions">
          <label className="guided-setup__consent">
            <input type="checkbox" checked={consent} disabled={busy} onChange={(event) => onConsentChange(event.target.checked)} />
            <span>{copy.installConsent}</span>
            <code>{driverText(driver, driver.install_cmd.join(' '))}</code>
          </label>
          <button type="button" className="guided-setup__button" disabled={busy || !canInstall(entry, consent)} onClick={onInstall}>
            {isInstalling ? copy.installing : copy.install}
          </button>
        </div>
      ) : null}
      {status === 'installed_unauthenticated' ? (
        <div className="guided-setup__actions">
          <button type="button" className="guided-setup__button" disabled={busy} onClick={onLogin}>
            {isLoggingIn ? copy.openingLogin : copy.login}
          </button>
        </div>
      ) : null}
      {isInstalling || isLoggingIn ? (
        <div className="guided-setup__progress-wrap" role="status" aria-live="polite">
          <div className="guided-setup__progress" aria-hidden="true"><div className="guided-setup__progress-bar" /></div>
          <span className="guided-setup__progress-text">{isInstalling ? copy.installing : copy.openingLogin}</span>
        </div>
      ) : null}
      {feedback ? <p className="guided-setup__done-note" role="status">{feedback}</p> : null}
      {login ? (
        <p className="guided-setup__login-note">
          {loginNote}{' '}
          <a href={driver.official_url} target="_blank" rel="noreferrer">{driver.official_url}</a>
        </p>
      ) : null}
    </li>
  );
}

export interface GuidedSetupStepProps {
  locale: Locale;
  onReady(lineup: RecommendedLineup): void;
  /** Resolved client mode (`null` waits until `client.init()` completes before scanning). */
  apiMode?: ApiMode | null;
  /** Optional saved role->provider choices preserved when returning from Step 2. */
  initialRoles?: Record<string, string> | null;
  /** Defaults to a `BatonApiClient`; tests pass a fake. */
  api?: GuidedSetupApi;
}

/** Guided step 1: pick the workspace, turn on Git, inspect/install AI coding tools, and customize the team. */
export function GuidedSetupStep({ locale, onReady, apiMode, initialRoles = null, api: injectedApi }: GuidedSetupStepProps) {
  const api = injectedApi ?? getDefaultApi();
  const copy = MESSAGES[locale].guided.setup;
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [drivers, setDrivers] = useState<CliDriver[]>([]);
  const [entries, setEntries] = useState<Record<string, CliScanEntry>>({});
  const [lineup, setLineup] = useState<RecommendedLineup | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<string[] | undefined>(undefined);
  const [customRoles, setCustomRoles] = useState<Record<string, string> | null>(() => initialRoles);
  const [roleEditorOpen, setRoleEditorOpen] = useState(false);
  const [driverFilter, setDriverFilter] = useState<DriverFilter>('all');
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [logins, setLogins] = useState<Record<string, CliLoginResult>>({});
  const [installFeedback, setInstallFeedback] = useState<Record<string, string>>({});
  const [workspaceFeedback, setWorkspaceFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (failure) {
      setError(errorText(failure, locale));
    } finally {
      setBusy(null);
    }
  }, [locale]);

  const scanRegistry = useCallback(async (repoPath?: string) => {
    const result = await api.scanCliRegistry(repoPath);
    setEntries(Object.fromEntries(result.scan.drivers.map((entry) => [entry.id, entry])));
    setLineup(result.lineup);
  }, [api]);

  const scan = useCallback((repoPath?: string) => run('scan', () => scanRegistry(repoPath)), [run, scanRegistry]);

  useEffect(() => {
    if (apiMode === null) return;
    void run('load', async () => {
      const [info, registry, rolesCfg] = await Promise.all([
        api.getWorkspaceInfo(),
        api.getCliRegistry(),
        api.getRoles ? api.getRoles().catch(() => null) : Promise.resolve(null),
      ]);
      setWorkspace(info);
      setPathInput(info.path);
      setDrivers(registry.drivers);
      setConfiguredProviders(rolesCfg ? Object.keys(rolesCfg.providers) : undefined);
      await scanRegistry(info.path);
    });
  }, [api, apiMode, run, scanRegistry]);

  const refreshRolesConfig = useCallback(async () => {
    if (!api.getRoles) return;
    const rolesCfg = await api.getRoles().catch(() => null);
    setConfiguredProviders(rolesCfg ? Object.keys(rolesCfg.providers) : undefined);
  }, [api]);

  const selectFolder = () => run('workspace', async () => {
    setWorkspaceFeedback(null);
    const info = await api.selectWorkspace(pathInput.trim());
    setWorkspace(info);
    setPathInput(info.path);
    setCustomRoles(null);
    await Promise.all([scanRegistry(info.path), refreshRolesConfig()]);
    setWorkspaceFeedback(copy.folderSelected);
  });

  const browseFolder = () => run('browse', async () => {
    setWorkspaceFeedback(null);
    if (!api.browseWorkspace) {
      await selectFolder();
      return;
    }
    const picked = await api.browseWorkspace();
    if (picked.cancelled) return;
    setWorkspace(picked.workspace);
    setPathInput(picked.workspace.path);
    setCustomRoles(null);
    await Promise.all([scanRegistry(picked.workspace.path), refreshRolesConfig()]);
    setWorkspaceFeedback(copy.folderSelected);
  });

  const initGit = () => run('git', async () => {
    setWorkspaceFeedback(null);
    setWorkspace(await initGitAndRefresh(api));
    setWorkspaceFeedback(copy.gitEnabledDone);
  });

  const install = (driver: CliDriver) => run(`install:${driver.id}`, async () => {
    setInstallFeedback((current) => {
      const next = { ...current };
      delete next[driver.id];
      return next;
    });
    if (await installWithConsent(api, entries[driver.id], consent[driver.id] === true)) {
      setConsent((current) => ({ ...current, [driver.id]: false }));
      await scanRegistry(workspace?.path);
      setInstallFeedback((current) => ({ ...current, [driver.id]: copy.installedDone }));
    }
  });

  const login = (driver: CliDriver) => run(`login:${driver.id}`, async () => {
    const result = await api.loginCli(driver.id);
    setLogins((current) => ({ ...current, [driver.id]: result }));
  });

  const selectableProviders = useMemo(
    () => availableLineupProviders(lineup, drivers, entries, configuredProviders),
    [configuredProviders, drivers, entries, lineup],
  );

  const effectiveLineup = useMemo<RecommendedLineup | null>(() => {
    if (!lineup || !lineup.ready || !customRoles) return lineup;
    const allowed = new Set(selectableProviders);
    const nextRoles = Object.fromEntries(
      Object.entries(lineup.roles).map(([role, defaultProvider]) => {
        const override = customRoles[role];
        return [role, override && allowed.has(override) ? override : defaultProvider];
      }),
    );
    return { ...lineup, roles: nextRoles };
  }, [customRoles, lineup, selectableProviders]);

  const isCustomized = isLineupCustomized(lineup, effectiveLineup);
  const readyCount = drivers.filter((driver) => entries[driver.id]?.status === 'ready').length;
  const visibleDrivers = filterDrivers(drivers, entries, driverFilter);

  const workspaceBusyLabel = busy === 'browse'
    ? copy.browsing
    : busy === 'workspace'
      ? copy.switchingFolder
      : busy === 'git'
        ? copy.initializingGit
        : null;

  return (
    <div className="guided-setup">
      <section className="guided-setup__card">
        <div className="guided-setup__row guided-setup__row--spread">
          <h3 className="guided-setup__title">{copy.currentFolder}</h3>
          <button
            type="button"
            className="guided-setup__button guided-setup__button--primary"
            disabled={busy !== null}
            onClick={() => void browseFolder()}
          >
            {busy === 'browse' ? copy.browsing : copy.pickFolder}
          </button>
        </div>
        {workspace ? <p className="guided-setup__path"><code>{workspace.path}</code></p> : null}
        <div className="guided-setup__row">
          <input
            className="guided-setup__input"
            value={pathInput}
            aria-label={copy.currentFolder}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && busy === null && pathInput.trim() !== '') {
                event.preventDefault();
                void selectFolder();
              }
            }}
          />
          <button
            type="button"
            className="guided-setup__button"
            disabled={busy !== null || pathInput.trim() === ''}
            onClick={() => void selectFolder()}
          >
            {busy === 'workspace' ? copy.switchingFolder : copy.applyPath}
          </button>
        </div>
        {workspaceBusyLabel ? (
          <div className="guided-setup__progress-wrap" role="status" aria-live="polite">
            <div className="guided-setup__progress" aria-hidden="true"><div className="guided-setup__progress-bar" /></div>
            <span className="guided-setup__progress-text">{workspaceBusyLabel}</span>
          </div>
        ) : null}
        {workspaceFeedback ? <p className="guided-setup__done-note" role="status">{workspaceFeedback}</p> : null}
        {workspace ? (
          <p className="guided-setup__git" data-git={workspace.is_git_repo}>
            {workspace.is_git_repo ? copy.gitReady : copy.gitMissing}
          </p>
        ) : null}
        {workspace && !workspace.is_git_repo ? (
          <button type="button" className="guided-setup__button guided-setup__button--primary" disabled={busy !== null} onClick={() => void initGit()}>
            {busy === 'git' ? copy.initializingGit : copy.initGit}
          </button>
        ) : null}
      </section>

      <section className="guided-setup__card">
        <div className="guided-setup__row guided-setup__row--spread guided-setup__row--wrap">
          <div className="guided-setup__title-group">
            <h3 className="guided-setup__title">{copy.scanClis}</h3>
            {drivers.length > 0 ? (
              <span className="guided-setup__count" data-ready={readyCount > 0}>
                {copy.scanSummary(readyCount, drivers.length)}
              </span>
            ) : null}
          </div>
          <button type="button" className="guided-setup__button" disabled={busy !== null} onClick={() => void scan(workspace?.path)}>
            {busy === 'scan' || busy === 'load' ? copy.scanning : copy.scanClis}
          </button>
        </div>
        {drivers.length > 0 ? (
          <div className="guided-setup__filters" role="group" aria-label={copy.scanClis}>
            {([
              ['all', copy.filterAll],
              ['ready', copy.filterReady],
              ['needs_setup', copy.filterNeedsSetup],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="guided-setup__chip"
                aria-pressed={driverFilter === key}
                onClick={() => setDriverFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {busy === 'scan' || busy === 'load' ? (
          <div className="guided-setup__progress-wrap" role="status" aria-live="polite">
            <div className="guided-setup__progress" aria-hidden="true"><div className="guided-setup__progress-bar" /></div>
            <span className="guided-setup__progress-text">{copy.scanning}</span>
          </div>
        ) : null}
        <ul className="guided-setup__drivers">
          {visibleDrivers.map((driver) => (
            <GuidedDriverRow
              key={driver.id}
              locale={locale}
              driver={driver}
              entry={entries[driver.id]}
              consent={consent[driver.id] === true}
              busy={busy !== null}
              activeAction={busy}
              feedback={installFeedback[driver.id] ?? null}
              login={logins[driver.id] ?? null}
              onConsentChange={(value) => setConsent((current) => ({ ...current, [driver.id]: value }))}
              onInstall={() => void install(driver)}
              onLogin={() => void login(driver)}
            />
          ))}
        </ul>
      </section>

      {effectiveLineup ? (
        <section className="guided-setup__card" data-ready={effectiveLineup.ready}>
          <div className="guided-setup__row guided-setup__row--spread guided-setup__row--wrap">
            <div className="guided-setup__title-group">
              <h3 className="guided-setup__title">{effectiveLineup.ready ? copy.lineupReady : copy.lineupMissing}</h3>
              {isCustomized ? <span className="guided-setup__pill" data-status="ready">{copy.customBadge}</span> : null}
            </div>
            {effectiveLineup.ready && Object.keys(effectiveLineup.roles).length > 0 && selectableProviders.length > 1 ? (
              <button
                type="button"
                className="guided-setup__button"
                aria-expanded={roleEditorOpen}
                onClick={() => setRoleEditorOpen((open) => !open)}
              >
                {roleEditorOpen ? copy.hideCustomizeRoles : copy.customizeRoles}
              </button>
            ) : null}
          </div>
          {Object.keys(effectiveLineup.roles).length > 0 ? (
            <p className="guided-setup__lineup">{lineupSummary(effectiveLineup, locale)}</p>
          ) : null}
          {effectiveLineup.ready && lineup && selectableProviders.length > 1 ? (
            <div className="guided-setup__presets" role="group" aria-label={copy.customizeRoles}>
              <button
                type="button"
                className="guided-setup__chip"
                aria-pressed={!isCustomized}
                onClick={() => setCustomRoles(null)}
              >
                {copy.presetRecommended}
              </button>
              {selectableProviders.map((providerId) => {
                const uniform = Object.values(effectiveLineup.roles).every((assigned) => assigned === providerId);
                return (
                  <button
                    key={providerId}
                    type="button"
                    className="guided-setup__chip"
                    aria-pressed={uniform}
                    onClick={() => setCustomRoles(assignAllRoles(lineup, providerId).roles)}
                  >
                    {copy.presetAllProvider(formatProviderDisplay(providerId))}
                  </button>
                );
              })}
            </div>
          ) : null}
          {effectiveLineup.ready && lineup && roleEditorOpen && Object.keys(effectiveLineup.roles).length > 0 ? (
            <div className="guided-setup__role-grid">
              {Object.entries(effectiveLineup.roles).map(([role, assigned]) => (
                <label key={role} className="guided-setup__role-row">
                  <span className="guided-setup__role-label">{translateRole(role, locale)}</span>
                  <select
                    className="guided-setup__select"
                    value={assigned}
                    onChange={(event) => setCustomRoles(assignRoleProvider(effectiveLineup, role, event.currentTarget.value).roles)}
                  >
                    {selectableProviders.map((providerId) => (
                      <option key={providerId} value={providerId}>
                        {formatProviderDisplay(providerId)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : null}
          {effectiveLineup.ready ? (
            <div className="guided-setup__team-actions">
              <button
                type="button"
                className="guided-setup__button guided-setup__button--primary"
                disabled={busy !== null}
                onClick={() => confirmLineup(effectiveLineup, onReady)}
              >
                {isCustomized ? copy.useCustomLineup : copy.useLineup}
              </button>
              {isCustomized ? (
                <button
                  type="button"
                  className="guided-setup__button"
                  disabled={busy !== null}
                  onClick={() => setCustomRoles(null)}
                >
                  {copy.resetLineup}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="guided-setup__next">{lineupNotes(effectiveLineup, locale)}</p>
          )}
        </section>
      ) : null}

      {error ? <p className="guided-setup__error" role="alert">{error}</p> : null}
    </div>
  );
}
