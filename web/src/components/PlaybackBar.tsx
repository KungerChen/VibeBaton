import './PlaybackBar.css';
import './ui/ui.css';
import { Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
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
  fail: 'pill--warn',
  escalate: 'pill--err',
  reject: 'pill--err',
};

export function PlaybackBar({
  scenario,
  onScenarioChange,
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
  const eventLabel = currentEvent
    ? [currentEvent.kind, currentEvent.edge_id ?? currentEvent.node_id, currentEvent.outcome]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    : 'Ready';

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
        {SCENARIOS.map((value) => (
          <button
            className={`playback-bar__segment${scenario === value ? ' playback-bar__segment--active' : ''}`}
            key={value}
            type="button"
            disabled={disabled}
            aria-pressed={scenario === value}
            onClick={() => onScenarioChange(value)}
          >
            {SCENARIO_LABELS[value]}
          </button>
        ))}
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

      <span className={`playback-bar__event pill ${pillClass}`} title={eventLabel}>
        {eventLabel}
      </span>
    </div>
  );
}
