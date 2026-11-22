import './PlaybackBar.css';
import './ui/ui.css';
import { Film, Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { SPEEDS } from '../engine/playback';
import { useI18n } from '../i18n';
import { translateHandle } from '../i18n/presets';
import { SCENARIOS } from '../types/graph';
import type { PlaybackBarProps } from './types';

const PILL_CLASS_BY_OUTCOME: Record<string, string> = {
  pass: 'pill--ok',
  approve: 'pill--ok',
  completed: 'pill--ok',
  fail: 'pill--warn',
  minor_fix: 'pill--warn',
  escalate: 'pill--err',
  reject: 'pill--err',
};

export function PlaybackBar({
  scenario,
  onScenarioChange,
  replayActive = false,
  onToggleReplay,
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
  const progress = stepCount > 0 ? Math.min(100, Math.max(0, (stepIndex / stepCount) * 100)) : 0;
  const speedIndex = SPEEDS.findIndex((value) => value === speed);
  const nextSpeed = SPEEDS[(speedIndex + 1) % SPEEDS.length];
  const stepDisabled = disabled || stepIndex >= stepCount;
  const outcome = currentEvent?.outcome ?? null;
  const pillClass = (outcome ? PILL_CLASS_BY_OUTCOME[outcome] : undefined) ?? 'pill--muted';
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
    <div className="playback-bar panel" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="playback-bar__segments" role="group" aria-label={messages.playback.scenarioAria}>
        {SCENARIOS.map((value) => {
          const isActive = !replayActive && scenario === value;
          return (
            <button
              className={`playback-bar__segment${isActive ? ' playback-bar__segment--active' : ''}`}
              key={value}
              type="button"
              disabled={disabled}
              aria-pressed={isActive}
              onClick={() => onScenarioChange(value)}
            >
              {messages.playback.scenarios[value]}
            </button>
          );
        })}
        {onToggleReplay && (
          <button
            className={`playback-bar__segment playback-bar__segment--replay${
              replayActive ? ' playback-bar__segment--replay-active' : ''
            }`}
            type="button"
            aria-pressed={replayActive}
            title={messages.playback.replayTitle}
            onClick={onToggleReplay}
          >
            <Film size={12} aria-hidden="true" />
            <span>{messages.playback.replayButton}</span>
          </button>
        )}
      </div>

      <div className="playback-bar__controls">
        <button
          className="btn playback-bar__icon-button"
          type="button"
          disabled={disabled}
          aria-label={playing ? messages.playback.pause : messages.playback.play}
          onClick={onPlayPause}
        >
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <button
          className="btn playback-bar__icon-button"
          type="button"
          disabled={stepDisabled}
          aria-label={messages.playback.stepForward}
          onClick={onStep}
        >
          <SkipForward size={16} aria-hidden="true" />
        </button>
        <button
          className="btn playback-bar__icon-button"
          type="button"
          disabled={disabled}
          aria-label={messages.playback.reset}
          onClick={onReset}
        >
          <RotateCcw size={16} aria-hidden="true" />
        </button>
        <button
          className="btn playback-bar__speed"
          type="button"
          disabled={disabled}
          aria-label={messages.playback.speedAria(speed)}
          onClick={() => onSpeedChange(nextSpeed)}
        >
          {speed}x
        </button>
      </div>

      <div className="playback-bar__progress">
        <span className="playback-bar__step">{messages.playback.stepCount(stepIndex, stepCount)}</span>
        <div className="playback-bar__track" aria-hidden="true">
          <div className="playback-bar__fill" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <span
        className={`playback-bar__event${replayActive ? ' playback-bar__event--replay' : ''} pill ${pillClass}`}
        title={eventLabel}
      >
        {eventLabel}
      </span>
    </div>
  );
}
