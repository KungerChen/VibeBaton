import './PlaybackBar.css';
import './ui/ui.css';
import { Film, Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { SPEEDS } from '../engine/playback';
import { SCENARIOS, type Scenario } from '../types/graph';
import type { PlaybackBarProps } from './types';

const SCENARIO_LABELS: Record<Scenario, string> = {
  happy_path: 'Happy Path',
  gate_retry: 'Gate Retry',
  escalate: 'Escalate',
};

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
  const progress = stepCount > 0 ? Math.min(100, Math.max(0, (stepIndex / stepCount) * 100)) : 0;
  const speedIndex = SPEEDS.findIndex((value) => value === speed);
  const nextSpeed = SPEEDS[(speedIndex + 1) % SPEEDS.length];
  const stepDisabled = disabled || stepIndex >= stepCount;
  const outcome = currentEvent?.outcome ?? null;
  const pillClass = (outcome ? PILL_CLASS_BY_OUTCOME[outcome] : undefined) ?? 'pill--muted';
  const defaultEventLabel = currentEvent
    ? [currentEvent.kind, currentEvent.edge_id ?? currentEvent.node_id, currentEvent.outcome]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    : 'Ready';
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
      <div className="playback-bar__segments" role="group" aria-label="Scenario">
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
              {SCENARIO_LABELS[value]}
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
            title="Replay real Stage 1 self-hosting run (run-20261121-044454-3b1845 · 107m @ 60×)"
            onClick={onToggleReplay}
          >
            <Film size={12} aria-hidden="true" />
            <span>Stage 1 60×</span>
          </button>
        )}
      </div>

      <div className="playback-bar__controls">
        <button
          className="btn playback-bar__icon-button"
          type="button"
          disabled={disabled}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={onPlayPause}
        >
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <button
          className="btn playback-bar__icon-button"
          type="button"
          disabled={stepDisabled}
          aria-label="Step forward"
          onClick={onStep}
        >
          <SkipForward size={16} aria-hidden="true" />
        </button>
        <button
          className="btn playback-bar__icon-button"
          type="button"
          disabled={disabled}
          aria-label="Reset playback"
          onClick={onReset}
        >
          <RotateCcw size={16} aria-hidden="true" />
        </button>
        <button
          className="btn playback-bar__speed"
          type="button"
          disabled={disabled}
          aria-label={`Playback speed ${speed}x`}
          onClick={() => onSpeedChange(nextSpeed)}
        >
          {speed}x
        </button>
      </div>

      <div className="playback-bar__progress">
        <span className="playback-bar__step">{`Step ${stepIndex} / ${stepCount}`}</span>
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
