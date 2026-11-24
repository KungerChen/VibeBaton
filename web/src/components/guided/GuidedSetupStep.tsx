import './GuidedSetupStep.css';
import { useCallback, useEffect, useState } from 'react';
import {
  BatonApiClient,
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
>;

let defaultApi: GuidedSetupApi | null = null;
function getDefaultApi(): GuidedSetupApi {
  return (defaultApi ??= new BatonApiClient());
}

const DSH_TEXT_RE = /\bdsh_(?:opencode|deepseek)\b/gi;

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
  login: CliLoginResult | null;
  onConsentChange(consent: boolean): void;
  onInstall(): void;
  onLogin(): void;
}

/** One toolkit row: name, tier badge, status pill and the action that fits the status. */
export function GuidedDriverRow({
  locale, driver, entry, consent, busy, login, onConsentChange, onInstall, onLogin,
}: GuidedDriverRowProps) {
  const copy = MESSAGES[locale].guided.setup;
  const status = entry?.status ?? 'missing';
  const reason = entry ? driverText(driver, locale === 'zh' ? entry.reason_zh : entry.reason_en) : '';
  const tierLabel = copy.tiers[driver.tier as keyof typeof copy.tiers] ?? driver.tier;
  const pill = status === 'ready' ? copy.ready : status === 'installed_unauthenticated' ? copy.needsLogin : copy.missing;
  const loginNote = login ? driverText(driver, locale === 'zh' ? login.message_zh : login.message_en) : '';

  return (
    <li className="guided-setup__driver" data-status={status}>
      <div className="guided-setup__driver-head">
        <span className="guided-setup__driver-name">{driverDisplayName(driver)}</span>
        <span className="guided-setup__tier" data-tier={driver.tier}>{tierLabel}</span>
        <span className="guided-setup__pill" data-status={status}>{pill}</span>
      </div>
      {status !== 'ready' && reason ? <p className="guided-setup__reason">{reason}</p> : null}
      {status === 'missing' ? (
        <div className="guided-setup__actions">
          <label className="guided-setup__consent">
            <input type="checkbox" checked={consent} onChange={(event) => onConsentChange(event.target.checked)} />
            <span>{copy.installConsent}</span>
            <code>{driverText(driver, driver.install_cmd.join(' '))}</code>
          </label>
          <button type="button" className="guided-setup__button" disabled={busy || !canInstall(entry, consent)} onClick={onInstall}>
            {copy.install}
          </button>
        </div>
      ) : null}
      {status === 'installed_unauthenticated' ? (
        <div className="guided-setup__actions">
          <button type="button" className="guided-setup__button" disabled={busy} onClick={onLogin}>{copy.login}</button>
        </div>
      ) : null}
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
  /** Defaults to a `BatonApiClient`; tests pass a fake. */
  api?: GuidedSetupApi;
}

/** Guided step 1: pick the workspace, turn on Git, check the AI coding tools and accept the team. */
export function GuidedSetupStep({ locale, onReady, api: injectedApi }: GuidedSetupStepProps) {
  const api = injectedApi ?? getDefaultApi();
  const copy = MESSAGES[locale].guided.setup;
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [drivers, setDrivers] = useState<CliDriver[]>([]);
  const [entries, setEntries] = useState<Record<string, CliScanEntry>>({});
  const [lineup, setLineup] = useState<RecommendedLineup | null>(null);
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [logins, setLogins] = useState<Record<string, CliLoginResult>>({});
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
    void run('load', async () => {
      const [info, registry] = await Promise.all([api.getWorkspaceInfo(), api.getCliRegistry()]);
      setWorkspace(info);
      setPathInput(info.path);
      setDrivers(registry.drivers);
      await scanRegistry(info.path);
    });
  }, [api, run, scanRegistry]);

  const selectFolder = () => run('workspace', async () => {
    const info = await api.selectWorkspace(pathInput.trim());
    setWorkspace(info);
    setPathInput(info.path);
    await scanRegistry(info.path);
  });

  const initGit = () => run('git', async () => setWorkspace(await initGitAndRefresh(api)));

  const install = (driver: CliDriver) => run(`install:${driver.id}`, async () => {
    if (await installWithConsent(api, entries[driver.id], consent[driver.id] === true)) {
      setConsent((current) => ({ ...current, [driver.id]: false }));
      await scanRegistry(workspace?.path);
    }
  });

  const login = (driver: CliDriver) => run(`login:${driver.id}`, async () => {
    const result = await api.loginCli(driver.id);
    setLogins((current) => ({ ...current, [driver.id]: result }));
  });

  return (
    <div className="guided-setup">
      <section className="guided-setup__card">
        <h3 className="guided-setup__title">{copy.currentFolder}</h3>
        {workspace ? <p className="guided-setup__path"><code>{workspace.path}</code></p> : null}
        <div className="guided-setup__row">
          <input
            className="guided-setup__input"
            value={pathInput}
            aria-label={copy.currentFolder}
            onChange={(event) => setPathInput(event.target.value)}
          />
          <button
            type="button"
            className="guided-setup__button"
            disabled={busy !== null || pathInput.trim() === ''}
            onClick={() => void selectFolder()}
          >
            {copy.pickFolder}
          </button>
        </div>
        {workspace ? (
          <p className="guided-setup__git" data-git={workspace.is_git_repo}>
            {workspace.is_git_repo ? copy.gitReady : copy.gitMissing}
          </p>
        ) : null}
        {workspace && !workspace.is_git_repo ? (
          <button type="button" className="guided-setup__button guided-setup__button--primary" disabled={busy !== null} onClick={() => void initGit()}>
            {copy.initGit}
          </button>
        ) : null}
      </section>

      <section className="guided-setup__card">
        <div className="guided-setup__row guided-setup__row--spread">
          <h3 className="guided-setup__title">{copy.scanClis}</h3>
          <button type="button" className="guided-setup__button" disabled={busy !== null} onClick={() => void scan(workspace?.path)}>
            {busy === 'scan' ? copy.scanning : copy.scanClis}
          </button>
        </div>
        <ul className="guided-setup__drivers">
          {drivers.map((driver) => (
            <GuidedDriverRow
              key={driver.id}
              locale={locale}
              driver={driver}
              entry={entries[driver.id]}
              consent={consent[driver.id] === true}
              busy={busy !== null}
              login={logins[driver.id] ?? null}
              onConsentChange={(value) => setConsent((current) => ({ ...current, [driver.id]: value }))}
              onInstall={() => void install(driver)}
              onLogin={() => void login(driver)}
            />
          ))}
        </ul>
      </section>

      {lineup ? (
        <section className="guided-setup__card" data-ready={lineup.ready}>
          <h3 className="guided-setup__title">{lineup.ready ? copy.lineupReady : copy.lineupMissing}</h3>
          {Object.keys(lineup.roles).length > 0 ? <p className="guided-setup__lineup">{lineupSummary(lineup, locale)}</p> : null}
          {lineup.ready ? (
            <button
              type="button"
              className="guided-setup__button guided-setup__button--primary"
              disabled={busy !== null}
              onClick={() => confirmLineup(lineup, onReady)}
            >
              {copy.useLineup}
            </button>
          ) : (
            <p className="guided-setup__next">{lineupNotes(lineup, locale)}</p>
          )}
        </section>
      ) : null}

      {error ? <p className="guided-setup__error" role="alert">{error}</p> : null}
    </div>
  );
}
