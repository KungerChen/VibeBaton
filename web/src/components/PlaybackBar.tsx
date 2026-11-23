import './PlaybackBar.css';
import './ui/ui.css';
import { Film, Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { OFFICIAL_STAGE1_CASE_ID } from '../engine/caseReplay';
import { SPEEDS } from '../engine/playback';
import { useI18n } from '../i18n';
import { translateHandle } from '../i18n/presets';
import { cn } from '../lib/utils';
import { SCENARIOS } from '../types/graph';
import { CASE_OPTION_PREFIX, replayToggleLabel, switcherOptions } from './playbackLabels';
import type { PlaybackBarProps } from './types';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';

const BADGE_BY_OUTCOME: Record<string, BadgeProps['variant']> = {
  pass: 'success',
  approve: 'success',
  completed: 'success',
  fail: 'warning',
  minor_fix: 'warning',
  escalate: 'destructive',
  reject: 'destructive',
};

export function PlaybackBar({
  scenario,
  onScenarioChange,
  replayActive = false,
  onToggleReplay,
  activeCaseId,
  activeCaseTitle,
  isCustomCaseActive,
  replayCaseLabel,
  savedCases,
  summaryPill,
  onSelectReplayCase,
  onImportCaseRequest,
  onResetTutorialCase,
  playing,
  onPlayPause,
  onStep,
  onReset,
  speed,
  onSpeedChange,
  stepIndex,
  stepCount,
  currentEvent,
  disabled = false,
}: PlaybackBarProps) {
  const { locale, messages } = useI18n();
  const copy = messages.transfer.playback;
  const replayLabel = replayToggleLabel({ isCustomCaseActive, activeCaseTitle }, messages);
  const caseOptions = switcherOptions(savedCases, OFFICIAL_STAGE1_CASE_ID, messages);
  const progress = stepCount > 0 ? Math.min(100, Math.max(0, (stepIndex / stepCount) * 100)) : 0;
  const speedIndex = SPEEDS.findIndex((value) => value === speed);
  const nextSpeed = SPEEDS[(speedIndex + 1) % SPEEDS.length];
  const stepDisabled = disabled || stepIndex >= stepCount;
  const outcome = currentEvent?.outcome ?? null;
  const badgeVariant = (outcome ? BADGE_BY_OUTCOME[outcome] : undefined) ?? 'outline';
  const defaultEventLabel = currentEvent
    ? [
        messages.playback.traceKinds[currentEvent.kind] ?? currentEvent.kind,
        currentEvent.edge_id ?? currentEvent.node_id,
        currentEvent.outcome ? translateHandle(currentEvent.outcome, locale) : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    : messages.playback.ready;
  const eventLabel = replayActive && currentEvent?.message ? currentEvent.message : defaultEventLabel;

  const handleReplayToggle = () => {
    // A custom case's button starts (or restarts) that case instead of leaving replay.
    if (isCustomCaseActive) {
      onSelectReplayCase(activeCaseId);
      return;
    }
    onToggleReplay?.();
  };

  const handleCaseSelect = (value: string) => {
    const option = caseOptions.find((entry) => entry.value === value);
    if (!option) return;
    if (option.kind === 'case') {
      onSelectReplayCase(option.caseId);
    } else if (option.kind === 'import') {
      onImportCaseRequest();
    } else {
      onResetTutorialCase();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.target !== event.currentTarget) return;

    if (event.key === ' ') {
      event.preventDefault();
      onPlayPause();
    } else if (event.key === 'ArrowRight' && !stepDisabled) {
      event.preventDefault();
      onStep();
    }
  };

  return (
    <div
      className="playback-bar panel rounded-2xl border border-border-strong bg-[var(--glass-bg)] shadow-[var(--shadow-lg)] backdrop-blur-xl"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div
        className="flex flex-none items-center gap-0.5 rounded-xl border border-border bg-muted/85 p-0.5"
        role="group"
        aria-label={messages.playback.scenarioAria}
      >
        {SCENARIOS.map((value) => {
          const isActive = !replayActive && scenario === value;
          return (
            <button
              key={value}
              type="button"
              disabled={disabled}
              aria-pressed={isActive}
              onClick={() => onScenarioChange(value)}
              className={cn(
                'rounded-lg px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-all cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed',
                isActive
                  ? 'bg-card font-semibold text-text-strong shadow-xs'
                  : 'text-muted-foreground hover:text-text-strong',
              )}
            >
              {messages.playback.scenarios[value]}
            </button>
          );
        })}

        {onToggleReplay && (
          <>
            <span className="mx-0.5 h-4 w-px bg-border-strong" aria-hidden="true" />
            <button
              type="button"
              aria-pressed={replayActive}
              title={isCustomCaseActive ? replayCaseLabel : copy.tutorialTooltip}
              onClick={handleReplayToggle}
              className={cn(
                'inline-flex max-w-64 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition-all cursor-pointer',
                replayActive
                  ? 'bg-[var(--sky-soft)] text-[var(--sky)] shadow-xs'
                  : 'text-[var(--sky)] hover:bg-[var(--sky-soft)]/60',
              )}
            >
              <Film size={12} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 truncate">{replayLabel}</span>
            </button>
          </>
        )}
      </div>

      <select
        className="playback-bar__case-select"
        aria-label={copy.switcherLabel}
        title={copy.switcherLabel}
        value={CASE_OPTION_PREFIX + activeCaseId}
        onChange={(event) => handleCaseSelect(event.target.value)}
      >
        {caseOptions.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>

      <div className="flex flex-none items-center gap-1">
        <Button
          variant="default"
          size="icon-sm"
          disabled={disabled}
          aria-label={playing ? messages.playback.pause : messages.playback.play}
          onClick={onPlayPause}
          className="rounded-lg"
        >
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={stepDisabled}
          aria-label={messages.playback.stepForward}
          onClick={onStep}
        >
          <SkipForward size={14} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={messages.playback.reset}
          onClick={onReset}
        >
          <RotateCcw size={14} aria-hidden="true" />
        </Button>
        <Button
          variant="secondary"
          size="xs"
          disabled={disabled}
          aria-label={messages.playback.speedAria(speed)}
          onClick={() => onSpeedChange(nextSpeed)}
          className="min-w-11 font-mono tabular-nums"
        >
          {speed}x
        </Button>
      </div>

      <div className="flex flex-none flex-col gap-1 w-28">
        <span className="text-[11px] font-medium font-mono tabular-nums text-muted-foreground whitespace-nowrap">
          {messages.playback.stepCount(stepIndex, stepCount)}
        </span>
        <div className="h-1 overflow-hidden rounded-full bg-border-strong" aria-hidden="true">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {summaryPill ? (
        <span className="playback-bar__summary-pill" title={summaryPill}>{summaryPill}</span>
      ) : null}

      <Badge
        variant={badgeVariant}
        className={cn(
          'max-w-60 truncate py-1 px-2.5',
          replayActive && 'max-w-88',
        )}
        title={eventLabel}
      >
        <span className="truncate">{eventLabel}</span>
      </Badge>
    </div>
  );
}
