import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  ModelCatalogResponse, ProjectSize, RecommendedLineup, SavedLineupProfile,
  WorkflowLineup, WorkflowMode, WorkflowRecommendation,
} from '../../api/client';
import { useI18n } from '../../i18n';
import type { GuidedM3Messages, Locale } from '../../i18n/messages';
import { formatProviderDisplay, translateRole } from '../../i18n/presets';
import {
  applySavedLineup, assignRoleModelSpec, assignRoleProvider, coerceEffort,
  effortOptionsFor, effortSourceFor, modelsForProvider, parseRoleSpec,
} from './GuidedSetupStep';
import { WorkflowSwitchPill } from './WorkflowSwitchPill';
import './GuidedLaunchBar.css';

type Catalog = Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers' | 'efforts'>;
type RecommendationCopy = GuidedM3Messages['recommendation'];

const MAX_REASONS = 3;
const ARRANGEMENTS = ['small_eco', 'medium_relay', 'large_panel', 'large_relay', 'custom_lineup_kept'] as const;
type Arrangement = typeof ARRANGEMENTS[number];

export interface TeamRow {
  role: string;
  roleLabel: string;
  tool: string;
  model: string;
  effort: string;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function sizeWord(size: ProjectSize | null, copy: RecommendationCopy): string {
  return size ? copy.sizeWords[size] : copy.sizeWords.medium;
}

/** One row per role with display names only: tool, catalog model label, effort label. */
export function teamRows(lineup: Pick<RecommendedLineup, 'roles' | 'model_overrides'>, catalog: Catalog,
  locale: Locale, defaultModel: string): TeamRow[] {
  return Object.entries(lineup.roles).map(([role, provider]) => {
    const spec = parseRoleSpec(lineup.model_overrides?.[role] ?? '', provider);
    const entry = modelsForProvider(catalog.models, provider).find((model) => model.id === spec.model)
      ?? catalog.models.find((model) => model.id === spec.model);
    const effort = spec.effort
      ? effortOptionsFor(entry, provider, catalog.efforts).find((option) => option.id === spec.effort)?.label
        ?? catalog.efforts.find((option) => option.id === spec.effort)?.label ?? spec.effort
      : '';
    return {
      role,
      roleLabel: translateRole(role, locale),
      tool: formatProviderDisplay(provider),
      model: spec.model ? entry?.label ?? spec.model : defaultModel,
      effort,
    };
  });
}

/** Adjacent roles on the same tool, model and effort share one row (a small team shows as two or three rows). */
export function mergeTeamRows(rows: readonly TeamRow[], separator: string): TeamRow[] {
  const merged: TeamRow[] = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (last && last.tool === row.tool && last.model === row.model && last.effort === row.effort) {
      merged[merged.length - 1] = { ...last, role: `${last.role}+${row.role}`, roleLabel: `${last.roleLabel}${separator}${row.roleLabel}` };
    } else {
      merged.push({ ...row });
    }
  }
  return merged;
}

/** The one-sentence conclusion for the arrangement the backend chose. */
export function recommendationHeadline(recommendation: WorkflowRecommendation, copy: RecommendationCopy): string {
  if (!recommendation.lineup) return copy.headlines.no_lineup;
  const code = ARRANGEMENTS.find((item) => item === recommendation.reason_code)
    ?? (recommendation.mode === 'panel' ? 'large_panel' : 'medium_relay');
  return fill(copy.headlines[code as Arrangement], { size: sizeWord(recommendation.size, copy) });
}

/** Up to three plain reasons in backend order (size and its basis, the arrangement, then notes). */
export function recommendationReasons(recommendation: WorkflowRecommendation, copy: RecommendationCopy): string[] {
  const codes = recommendation.explanation_codes.length
    ? recommendation.explanation_codes
    : [recommendation.reason_code || recommendation.explanation_key.replace(/^workflow\./, '')];
  const values = {
    size: sizeWord(recommendation.size, copy),
    names: (recommendation.missing_panelists ?? []).map(formatProviderDisplay).join(', '),
  };
  const texts = codes.map((code) => {
    const template = copy.reasons[code as keyof RecommendationCopy['reasons']];
    return template ? fill(template, values) : null;
  }).filter((text): text is string => !!text);
  return [...new Set(texts.length ? texts : [copy.unknownReason])].slice(0, MAX_REASONS);
}

export type FlowReason = 'size_not_small' | 'panel_mode' | 'lean_flow_off' | 'no_verification_command';

export interface LaunchFlow {
  flow: 'lean' | 'full';
  /** Why the lean flow is not used; null for a lean run. */
  reason: FlowReason | null;
  /** This run may switch between the lean and the full flow. */
  switchable: boolean;
}

/** One plain sentence for the flow, and why the lean flow is not used. */
export interface FlowLine {
  text: string;
  reason: string | null;
}

interface FlowRequest {
  mode: WorkflowMode;
  lineup: Pick<WorkflowLineup, 'size'>;
  lean_flow?: boolean;
}

/**
 * The flow the engine picks for this request: the checks of `workflow_recommend.plan_flow`, in its order.
 * Null while no small recommendation has said whether the RFC has a check the gate can run as written.
 */
export function requestFlow(request: FlowRequest,
  recommendation: Pick<WorkflowRecommendation, 'size' | 'flow'> | null): LaunchFlow | null {
  if (request.lineup.size !== 'small') return { flow: 'full', reason: 'size_not_small', switchable: false };
  if (request.mode === 'panel') return { flow: 'full', reason: 'panel_mode', switchable: false };
  if (request.lean_flow === false) return { flow: 'full', reason: 'lean_flow_off', switchable: true };
  if (recommendation?.size !== 'small' || !recommendation.flow) return null;
  return recommendation.flow === 'lean'
    ? { flow: 'lean', reason: null, switchable: true }
    : { flow: 'full', reason: 'no_verification_command', switchable: false };
}

/** A revision keeps its parent's flow setting; an unknown flow says it is still being checked. */
export function flowLine(flow: LaunchFlow | 'inherited' | null, size: ProjectSize | null | undefined,
  copy: GuidedM3Messages): FlowLine {
  if (flow === 'inherited') return { text: copy.launch.flowInherited, reason: null };
  if (!flow) return { text: copy.launch.flowChecking, reason: null };
  if (flow.flow === 'lean') return { text: copy.launch.flowLean, reason: null };
  return {
    text: size === 'small' ? copy.launch.flowFullSmall : copy.launch.flowFull,
    reason: flow.reason ? copy.launch.flowWhy[flow.reason] : null,
  };
}

/** The RFC title: its first line when that is a `# ` heading. */
export function rfcTitle(markdown: string): string | null {
  const first = markdown.split(/\r?\n/).find((line) => line.trim());
  const match = first ? /^#\s+(.+)$/.exec(first.trim()) : null;
  return match ? match[1].trim() : null;
}

export interface LaunchConfirmation {
  title: string;
  team: TeamRow[];
  mode: string;
  flow: FlowLine;
  budget: string;
  missingSections: string | null;
}

/** What the confirmation lists, rendered from the request the launch sends (or the saved pending one). */
export function launchConfirmation(
  request: FlowRequest & { rfc_markdown: string; lineup: Pick<WorkflowLineup, 'roles' | 'model_overrides' | 'size'> },
  catalog: Catalog,
  recommendation: Pick<WorkflowRecommendation, 'size' | 'flow'> | null,
  context: { locale: Locale; copy: GuidedM3Messages; inherited: boolean; budget: string; missingSections: readonly string[] },
): LaunchConfirmation {
  const { locale, copy } = context;
  const separator = locale === 'zh' ? '、' : ', ';
  return {
    title: rfcTitle(request.rfc_markdown) ?? copy.launch.untitled,
    team: mergeTeamRows(teamRows(request.lineup, catalog, locale, copy.lineup.defaultModel), separator),
    mode: request.mode === 'panel' ? copy.launch.modePanel : copy.recommendation.overnight,
    flow: flowLine(context.inherited ? 'inherited' : requestFlow(request, recommendation), request.lineup.size, copy),
    budget: context.budget,
    missingSections: context.missingSections.length
      ? fill(copy.launch.missingSections, { sections: context.missingSections.join(separator) }) : null,
  };
}

/** Whether the panel switch can be turned on, and the plain reason when it cannot. */
export function panelToggleState(panelFailure: string | null | undefined, locked: boolean):
  { disabled: boolean; reason: string | null } {
  return { disabled: locked || !!panelFailure, reason: panelFailure || null };
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

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
  /** This run's flow in plain words (`requestFlow`, then `flowLine`). */
  flow?: FlowLine;
  /** The switch back to the full flow, given only while this run may switch. */
  leanFlow?: { checked: boolean; onChange(checked: boolean): void } | null;
  /** When set, the card lists what will take effect and asks to confirm in place of the start button. */
  confirmation?: LaunchConfirmation | null;
  onConfirm?(): void;
  onCancelConfirm?(): void;
  /** Opens the place where the project budget is changed. */
  onOpenBudget?(): void;
}

/** The parent owns API calls, readiness, persisted choices, and launch idempotency. */
export function GuidedLaunchBar({
  recommendation, lineup, mode, previousSize, showSwitch, panelFailure, providers, catalog,
  profiles, pending, disabled, locked = false, profileError, onLineupChange, onModeChange,
  onSwitch, onDismissSwitch, onSaveProfile, onDeleteProfile, onLaunch,
  flow, leanFlow, confirmation, onConfirm, onCancelConfirm, onOpenBudget,
}: GuidedLaunchBarProps) {
  const { locale, messages } = useI18n();
  const copy = messages.guided.m3;
  const setup = messages.guided.setup;
  const panelHint = useId();
  const panelHelp = useId();
  const cardRef = useRef<HTMLElement>(null);
  const [profileName, setProfileName] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const controlsDisabled = pending || locked;
  const reasons = recommendationReasons(recommendation, copy.recommendation);
  const rows = mergeTeamRows(teamRows(lineup, catalog, locale, copy.lineup.defaultModel), locale === 'zh' ? '、' : ', ');
  const panel = panelToggleState(panelFailure, controlsDisabled);
  const choices = [...new Set([...providers, ...Object.values(lineup.roles)])];
  const thisRunOnly = <span className="guided-launch-bar__scope">{copy.launch.thisRunOnly}</span>;

  // The card appears once the blueprint is first ready; bring it into view.
  useEffect(() => {
    cardRef.current?.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  }, []);

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
    <section ref={cardRef} className="guided-launch-bar" aria-label={copy.launch.title}>
      <div className="guided-launch-bar__recommendation">
        <span className="guided-launch-bar__eyebrow">{copy.recommendation.title}</span>
        <p className="guided-launch-bar__headline">{recommendationHeadline(recommendation, copy.recommendation)}</p>
        <ul className="guided-launch-bar__reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      </div>

      {rows.length ? (
        <div className="guided-launch-bar__team" role="table" aria-label={copy.lineup.title}>
          <div className="guided-launch-bar__team-row guided-launch-bar__team-row--head" role="row">
            <span role="columnheader">{copy.lineup.role}</span>
            <span role="columnheader">{copy.lineup.provider}</span>
            <span role="columnheader">{copy.lineup.model}</span>
            <span role="columnheader">{copy.lineup.effort}</span>
          </div>
          {rows.map((row) => (
            <div key={row.role} className="guided-launch-bar__team-row" role="row">
              <span role="cell" className="guided-launch-bar__team-role">{row.roleLabel}</span>
              <span role="cell" className="guided-launch-bar__team-tool">{row.tool}</span>
              <span role="cell" className="guided-launch-bar__team-model">{row.model}</span>
              <span role="cell" className="guided-launch-bar__team-effort">{row.effort || '—'}</span>
            </div>
          ))}
        </div>
      ) : null}

      {showSwitch ? (
        <WorkflowSwitchPill currentSize={previousSize} recommendedSize={recommendation.size}
          recommendedMode={recommendation.mode} disabled={controlsDisabled || (recommendation.mode === 'panel' && !!panelFailure)}
          onSwitch={onSwitch} onDismiss={onDismissSwitch} />
      ) : null}

      <details className="guided-launch-bar__drawer">
        <summary>{copy.lineup.open}{thisRunOnly}</summary>
        <p className="guided-launch-bar__drawer-note">{copy.lineup.description}</p>
        {Object.entries(lineup.roles).map(([role, provider]) => {
          const parsed = parseRoleSpec(lineup.model_overrides?.[role] ?? '', provider);
          const models = modelsForProvider(catalog.models, provider);
          const selectedModel = models.find((model) => model.id === parsed.model);
          const efforts = effortOptionsFor(selectedModel, provider, catalog.efforts);
          // A known model whose tool takes no effort shows a note instead of a picker.
          const noEffort = !!selectedModel && efforts.length === 0;
          const unverified = effortSourceFor(selectedModel, provider) === 'default';
          return (
            <fieldset key={role} disabled={controlsDisabled} className="guided-launch-bar__role"
              aria-label={translateRole(role, locale)}>
              <span className="guided-launch-bar__role-name">{translateRole(role, locale)}</span>
              <label>{copy.lineup.provider}
                <select className="guided-setup__input" value={provider}
                  onChange={(event) => onLineupChange(assignRoleProvider(lineup, role, event.currentTarget.value, catalog))}>
                  {choices.map((choice) => <option key={choice} value={choice}>{formatProviderDisplay(choice)}</option>)}
                </select>
              </label>
              <label>{copy.lineup.model}
                <select className="guided-setup__input" value={parsed.model} onChange={(event) => {
                  const next = models.find((model) => model.id === event.currentTarget.value);
                  const available = effortOptionsFor(next, provider, catalog.efforts);
                  const effort = coerceEffort(parsed.effort, available,
                    next?.provider_defaults?.[provider] ?? next?.default_effort ?? '');
                  onLineupChange(assignRoleModelSpec(lineup, role, provider, event.currentTarget.value, effort));
                }}>
                  <option value="">{setup.modelGroupLatest}</option>
                  {parsed.model && !selectedModel ? <option value={parsed.model}>{parsed.model}</option> : null}
                  {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </label>
              {noEffort ? (
                <p className="guided-launch-bar__effort-none">{setup.effortUnsupported}</p>
              ) : (
                <label>
                  <span>
                    {copy.lineup.effort}
                    {unverified ? (
                      <span className="guided-launch-bar__unverified" title={setup.effortUnverifiedTitle}>
                        {setup.effortUnverified}
                      </span>
                    ) : null}
                  </span>
                  <select className="guided-setup__input" value={parsed.effort} disabled={!parsed.model} onChange={(event) =>
                    onLineupChange(assignRoleModelSpec(lineup, role, provider, parsed.model, event.currentTarget.value))}>
                    <option value="">—</option>
                    {parsed.effort && !efforts.some((effort) => effort.id === parsed.effort)
                      ? <option value={parsed.effort}>{parsed.effort}</option> : null}
                    {efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
                  </select>
                </label>
              )}
            </fieldset>
          );
        })}
        {profiles.length ? (
          <div className="guided-launch-bar__saved">
            <label>{setup.savedProfilesTitle}
              <select className="guided-setup__input" disabled={controlsDisabled} value="" onChange={(event) => {
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
                <button type="button" className="guided-setup__button" disabled={controlsDisabled}
                  aria-label={setup.deleteProfileAria(profile.name)}
                  onClick={() => { void onDeleteProfile(profile.id).catch(() => {}); }}>×</button>
              </li>)}
            </ul>
          </div>
        ) : null}
        <form className="guided-launch-bar__profile" onSubmit={(event) => { void saveProfile(event).catch(() => {}); }}>
          <input className="guided-setup__input" aria-label={setup.saveProfilePlaceholder} placeholder={setup.saveProfilePlaceholder}
            value={profileName} disabled={controlsDisabled} onChange={(event) => setProfileName(event.currentTarget.value)} />
          <button type="submit" className="guided-setup__button" disabled={controlsDisabled || savingProfile || !profileName.trim()}>
            {savingProfile ? setup.savingProfile : setup.saveProfileButton}
          </button>
        </form>
        {profileError ? <p role="alert" className="guided-launch-bar__panel-hint">{profileError}</p> : null}
      </details>

      {flow ? (
        <div className="guided-launch-bar__flow">
          <p className="guided-launch-bar__flow-text">{flow.text}</p>
          {flow.reason ? <p className="guided-launch-bar__panel-help">{flow.reason}</p> : null}
          {leanFlow ? (
            <label className="guided-launch-bar__panel-switch">
              <input type="checkbox" role="switch" checked={leanFlow.checked} disabled={controlsDisabled}
                onChange={(event) => leanFlow.onChange(event.currentTarget.checked)} />
              <span className="guided-launch-bar__panel-title">{copy.launch.leanSwitch}</span>
              {thisRunOnly}
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="guided-launch-bar__footer">
        <div className="guided-launch-bar__panel">
          <label className="guided-launch-bar__panel-switch">
            <input type="checkbox" role="switch" checked={mode === 'panel'} disabled={panel.disabled}
              aria-describedby={panel.reason ? `${panelHelp} ${panelHint}` : panelHelp}
              onChange={(event) => onModeChange(event.currentTarget.checked ? 'panel' : 'overnight')} />
            <span className="guided-launch-bar__panel-title">{copy.recommendation.panel}</span>
            {thisRunOnly}
          </label>
          <p id={panelHelp} className="guided-launch-bar__panel-help">{copy.recommendation.panelHelp}</p>
          {panel.reason ? (
            <p id={panelHint} className="guided-launch-bar__panel-hint">
              {copy.recommendation.panelUnavailable}{panel.reason}
            </p>
          ) : recommendation.missing_panelists?.length ? (
            <p className="guided-launch-bar__panel-hint">
              {fill(copy.recommendation.panelPartial, {
                names: recommendation.missing_panelists.map(formatProviderDisplay).join(', '),
              })}
            </p>
          ) : null}
        </div>
        {confirmation ? null : (
          <button type="button" className="guided-launch-bar__launch" disabled={disabled || pending} onClick={onLaunch}>
            {pending ? copy.launch.launching : copy.launch.action}
          </button>
        )}
      </div>

      {confirmation ? (
        <section className="guided-launch-bar__confirm" aria-label={copy.launch.confirmTitle}>
          <span className="guided-launch-bar__eyebrow">{copy.launch.confirmTitle}</span>
          <dl className="guided-launch-bar__facts">
            <dt>{copy.launch.confirmDocument}</dt>
            <dd>{confirmation.title}</dd>
            <dt>{copy.launch.confirmTeam}{thisRunOnly}</dt>
            <dd>
              <ul className="guided-launch-bar__confirm-team">
                {confirmation.team.map((row) => (
                  <li key={row.role}>{row.roleLabel}: {[row.tool, row.model, row.effort || '—'].join(' · ')}</li>
                ))}
              </ul>
            </dd>
            <dt>{copy.launch.confirmMode}{thisRunOnly}</dt>
            <dd>{confirmation.mode}</dd>
            <dt>{copy.launch.confirmFlow}{thisRunOnly}</dt>
            <dd>
              <p>{confirmation.flow.text}</p>
              {confirmation.flow.reason ? <p>{confirmation.flow.reason}</p> : null}
            </dd>
            <dt>{copy.launch.confirmBudget}<span className="guided-launch-bar__scope">{copy.launch.projectDefault}</span></dt>
            <dd>
              {confirmation.budget}
              {onOpenBudget ? (
                <button type="button" className="guided-launch-bar__link" onClick={onOpenBudget}>{copy.launch.changeBudget}</button>
              ) : null}
            </dd>
          </dl>
          {confirmation.missingSections ? (
            <p className="guided-launch-bar__confirm-warning" role="alert">{confirmation.missingSections}</p>
          ) : null}
          <div className="guided-launch-bar__confirm-actions">
            <button type="button" className="guided-setup__button" disabled={pending} onClick={onCancelConfirm}>
              {copy.launch.back}
            </button>
            <button type="button" className="guided-launch-bar__confirm-start" autoFocus disabled={disabled || pending}
              onClick={onConfirm}>
              {pending ? copy.launch.launching : copy.launch.confirm}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
