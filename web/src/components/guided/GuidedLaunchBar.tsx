import { useId, useState, type FormEvent } from 'react';
import type {
  ModelCatalogResponse, ProjectSize, RecommendedLineup, SavedLineupProfile,
  WorkflowMode, WorkflowRecommendation,
} from '../../api/client';
import { useI18n } from '../../i18n';
import { formatProviderDisplay, translateRole } from '../../i18n/presets';
import {
  applySavedLineup, assignRoleModelSpec, assignRoleProvider, coerceEffort,
  effortOptionsFor, modelsForProvider, parseRoleSpec,
} from './GuidedSetupStep';
import { WorkflowSwitchPill } from './WorkflowSwitchPill';
import './GuidedLaunchBar.css';

type Catalog = Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers' | 'efforts'>;

export interface GuidedLaunchBarProps {
  recommendation: WorkflowRecommendation;
  lineup: RecommendedLineup;
  mode: WorkflowMode;
  previousSize: ProjectSize | null;
  showSwitch: boolean;
  /** A real panel preflight failure, if one was reported by the server. */
  panelFailure?: string | null;
  providers: readonly string[];
  catalog: Catalog;
  profiles: readonly SavedLineupProfile[];
  pending: boolean;
  disabled: boolean;
  locked?: boolean;
  profileError?: string | null;
  onLineupChange(lineup: RecommendedLineup): void;
  onModeChange(mode: WorkflowMode): void;
  onSwitch(): void;
  onDismissSwitch(): void;
  onSaveProfile(name: string): Promise<void>;
  onDeleteProfile(profileId: string): Promise<void>;
  onLaunch(): void;
}

/** The parent owns API calls, readiness, persisted choices, and launch idempotency. */
export function GuidedLaunchBar({
  recommendation, lineup, mode, previousSize, showSwitch, panelFailure, providers, catalog,
  profiles, pending, disabled, locked = false, profileError, onLineupChange, onModeChange,
  onSwitch, onDismissSwitch, onSaveProfile, onDeleteProfile, onLaunch,
}: GuidedLaunchBarProps) {
  const { locale, messages } = useI18n();
  const copy = messages.guided.m3;
  const setup = messages.guided.setup;
  const panelHint = useId();
  const [profileName, setProfileName] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const controlsDisabled = pending || locked;
  const reasons = recommendation.explanation_codes.length
    ? recommendation.explanation_codes
    : [recommendation.reason_code || recommendation.explanation_key.replace(/^workflow\./, '')];
  const reasonText = (reason: string) => copy.recommendation.reasons[reason as keyof typeof copy.recommendation.reasons]
    ?? copy.recommendation.unknownReason;
  const choices = [...new Set([...providers, ...Object.values(lineup.roles)])];
  const teamSummary = Object.entries(lineup.roles)
    .map(([role, provider]) => {
      const spec = parseRoleSpec(lineup.model_overrides?.[role] ?? '', provider);
      const target = spec.model ? `${formatProviderDisplay(provider)}:${spec.model}${spec.effort ? `@${spec.effort}` : ''}` : formatProviderDisplay(provider);
      return `${translateRole(role, locale)}: ${target}`;
    })
    .join(locale === 'zh' ? '；' : '; ');

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileName.trim() || savingProfile || controlsDisabled) return;
    setSavingProfile(true);
    try {
      await onSaveProfile(profileName.trim());
      setProfileName('');
    } finally {
      setSavingProfile(false);
    }
  }

  return (
    <section className="guided-launch-bar" aria-label={copy.launch.title}>
      <div className="guided-launch-bar__recommendation">
        <strong>{copy.recommendation.title}: {copy.recommendation[recommendation.mode]}</strong>
        <span>{copy.recommendation.size}: {recommendation.size ? copy.recommendation[recommendation.size] : copy.recommendation.unknownSize}</span>
        {recommendation.fallback ? <span>{copy.recommendation.fallback}</span> : null}
        <ul>{reasons.map((reason) => <li key={reason}>{reasonText(reason)}</li>)}</ul>
        {recommendation.substitutions.length ? (
          <p>{copy.recommendation.substitutions}: {recommendation.substitutions.map((item) =>
            `${translateRole(item.role, locale)}: ${formatProviderDisplay(item.preferred_provider)} → ${formatProviderDisplay(item.chosen_provider)}`).join(', ')}</p>
        ) : null}
        {teamSummary ? <p>{messages.guided.workbench.currentTeamPrefix} {teamSummary}</p> : null}
      </div>
      {showSwitch ? (
        <WorkflowSwitchPill currentSize={previousSize} recommendedSize={recommendation.size}
          recommendedMode={recommendation.mode} disabled={controlsDisabled || (recommendation.mode === 'panel' && !!panelFailure)}
          onSwitch={onSwitch} onDismiss={onDismissSwitch} />
      ) : null}
      <details className="guided-launch-bar__drawer">
        <summary>{copy.lineup.open}</summary>
        <p>{copy.lineup.description}</p>
        {Object.entries(lineup.roles).map(([role, provider]) => {
          const parsed = parseRoleSpec(lineup.model_overrides?.[role] ?? '', provider);
          const models = modelsForProvider(catalog.models, provider);
          const selectedModel = models.find((model) => model.id === parsed.model);
          const efforts = effortOptionsFor(selectedModel, provider, catalog.efforts);
          return (
            <fieldset key={role} disabled={controlsDisabled} className="guided-launch-bar__role">
              <legend>{translateRole(role, locale)}</legend>
              <label>{copy.lineup.provider}
                <select value={provider} onChange={(event) => onLineupChange(assignRoleProvider(lineup, role, event.currentTarget.value, catalog))}>
                  {choices.map((choice) => <option key={choice} value={choice}>{formatProviderDisplay(choice)}</option>)}
                </select>
              </label>
              <label>{copy.lineup.model}
                <select value={parsed.model} onChange={(event) => {
                  const next = models.find((model) => model.id === event.currentTarget.value);
                  const available = effortOptionsFor(next, provider, catalog.efforts);
                  const effort = coerceEffort(parsed.effort, available, next?.default_effort ?? '');
                  onLineupChange(assignRoleModelSpec(lineup, role, provider, event.currentTarget.value, effort));
                }}>
                  <option value="">{setup.modelGroupLatest}</option>
                  {parsed.model && !selectedModel ? <option value={parsed.model}>{parsed.model}</option> : null}
                  {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </label>
              <label>{copy.lineup.effort}
                <select value={parsed.effort} disabled={!parsed.model} onChange={(event) =>
                  onLineupChange(assignRoleModelSpec(lineup, role, provider, parsed.model, event.currentTarget.value))}>
                  <option value="">—</option>
                  {parsed.effort && !efforts.some((effort) => effort.id === parsed.effort)
                    ? <option value={parsed.effort}>{parsed.effort}</option> : null}
                  {efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
                </select>
              </label>
            </fieldset>
          );
        })}
        {profiles.length ? (
          <div>
            <label>{setup.savedProfilesTitle}
              <select disabled={controlsDisabled} value="" onChange={(event) => {
                const profile = profiles.find((item) => item.id === event.currentTarget.value);
                if (profile) onLineupChange(applySavedLineup(lineup, profile, choices, catalog));
              }}>
                <option value="">—</option>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </label>
            <ul className="guided-launch-bar__profiles">
              {profiles.map((profile) => <li key={profile.id}>
                <span>{profile.name}</span>
                <button type="button" disabled={controlsDisabled} aria-label={setup.deleteProfileAria(profile.name)}
                  onClick={() => { void onDeleteProfile(profile.id).catch(() => {}); }}>×</button>
              </li>)}
            </ul>
          </div>
        ) : null}
        <form className="guided-launch-bar__profile" onSubmit={(event) => { void saveProfile(event).catch(() => {}); }}>
          <input aria-label={setup.saveProfilePlaceholder} placeholder={setup.saveProfilePlaceholder}
            value={profileName} disabled={controlsDisabled} onChange={(event) => setProfileName(event.currentTarget.value)} />
          <button type="submit" disabled={controlsDisabled || savingProfile || !profileName.trim()}>
            {savingProfile ? setup.savingProfile : setup.saveProfileButton}
          </button>
        </form>
        {profileError ? <p role="alert">{profileError}</p> : null}
      </details>
      <label className="guided-launch-bar__panel">
        <input type="checkbox" checked={mode === 'panel'} disabled={controlsDisabled || !!panelFailure}
          aria-describedby={panelFailure ? panelHint : undefined}
          onChange={(event) => onModeChange(event.currentTarget.checked ? 'panel' : 'overnight')} />
        {copy.recommendation.panel}
      </label>
      {panelFailure ? <p id={panelHint} className="guided-launch-bar__panel-hint">{panelFailure}</p> : null}
      <button type="button" className="guided-launch-bar__launch" disabled={disabled || pending} onClick={onLaunch}>
        {pending ? copy.launch.launching : copy.launch.action}
      </button>
    </section>
  );
}
