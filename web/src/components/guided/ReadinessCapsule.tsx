import './ReadinessCapsule.css';
import { CircleCheck, CircleX, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatProviderDisplay } from '../../i18n/presets';
import type { WorkspaceReadiness } from './GuidedSetupStep';

/** One plain line per reason; a check that could not run is its own blocking reason. */
export function readinessReasonTexts(readiness: WorkspaceReadiness | null, failed: boolean, locale: Locale): string[] {
  const copy = MESSAGES[locale].guided.m3.readiness;
  if (failed) return [copy.checkFailed];
  return (readiness?.reasons ?? []).map((reason) => reason.code === 'tools_unavailable'
    ? copy.toolsUnavailable.replace('{tools}', reason.providers.map(formatProviderDisplay).join(locale === 'zh' ? '、' : ', '))
    : { no_git: copy.noGit, no_commits: copy.noCommits, no_team: copy.noTeam }[reason.code]);
}

const ICONS = { ready: CircleCheck, partial: TriangleAlert, blocked: CircleX, checking: LoaderCircle };

export interface ReadinessCapsuleProps {
  locale: Locale;
  readiness: WorkspaceReadiness | null;
  /** The last check could not run, so nothing confirms the folder and tools: shown as blocked. */
  failed: boolean;
  checking: boolean;
  workspacePath: string | null;
  /** Whether the Workspace & Tools wizard is showing. */
  expanded: boolean;
  onToggle(): void;
  onRefresh(): void;
}

/** The workbench's readiness pill: state in words and an icon, the reasons, and the folder it checked. */
export function ReadinessCapsule({
  locale, readiness, failed, checking, workspacePath, expanded, onToggle, onRefresh,
}: ReadinessCapsuleProps) {
  const copy = MESSAGES[locale].guided.m3.readiness;
  const state = failed ? 'blocked' : readiness?.state ?? 'checking';
  const Icon = ICONS[state];
  const reasons = readinessReasonTexts(readiness, failed, locale).join(locale === 'zh' ? '；' : '; ');
  return (
    <div className="readiness-capsule" data-state={state}>
      <button type="button" className="readiness-capsule__pill" aria-expanded={expanded} title={copy.panelTitle} onClick={onToggle}>
        <Icon className="readiness-capsule__icon" size={14} aria-hidden="true" />
        <span className="readiness-capsule__label">{copy[state]}</span>
        {reasons ? <span className="readiness-capsule__reason">{reasons}</span> : null}
        {workspacePath ? <code className="readiness-capsule__path">{workspacePath}</code> : null}
      </button>
      <button type="button" className="readiness-capsule__refresh" aria-label={copy.refresh} title={copy.refresh}
        disabled={checking} onClick={onRefresh}>
        <RefreshCw size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
