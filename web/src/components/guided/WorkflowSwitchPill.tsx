import { useId } from 'react';
import type { WorkflowMode } from '../../api/client';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import './WorkflowSwitchPill.css';

export interface WorkflowSwitchPillProps {
  currentSize: 'small' | 'medium' | 'large' | null;
  recommendedSize: 'small' | 'medium' | 'large' | null;
  recommendedMode?: WorkflowMode;
  disabled?: boolean;
  onSwitch(): void;
  onDismiss(): void;
}

/**
 * A presentational leaf: its parent owns the recommendation and the preserved
 * lineup, and decides whether switching is safe to offer.
 */
export function WorkflowSwitchPill({
  currentSize,
  recommendedSize,
  recommendedMode,
  disabled = false,
  onSwitch,
  onDismiss,
}: WorkflowSwitchPillProps) {
  const { messages } = useI18n();
  const copy = messages.guided.m3.workflowSwitch;
  const recommendation = messages.guided.m3.recommendation;
  const labelId = useId();
  const hintId = useId();

  if (currentSize === null || recommendedSize === null || currentSize === recommendedSize) return null;

  const switchLabel = recommendedMode === 'panel'
    ? copy.switchToPanel
    : recommendedMode === 'overnight'
      ? copy.switchToOvernight
      : copy.switchAction;
  const modeLabel = recommendedMode ? copy[recommendedMode] : null;

  return (
    <section
      className="workflow-switch-pill"
      aria-labelledby={labelId}
      data-current-size={currentSize}
      data-recommended-size={recommendedSize}
      data-recommended-mode={recommendedMode}
    >
      <p className="workflow-switch-pill__message">
        <strong id={labelId} className="workflow-switch-pill__label">{copy.label}</strong>
        <span>{recommendation.sizeChanged}</span>
        <span className="workflow-switch-pill__sizes">
          {recommendation[currentSize]} → {recommendation[recommendedSize]}
        </span>
        {modeLabel ? <span className="workflow-switch-pill__mode">{modeLabel}</span> : null}
        {disabled ? <span id={hintId} className="workflow-switch-pill__hint">{copy.disabled}</span> : null}
      </p>
      <div className="workflow-switch-pill__actions">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          aria-describedby={disabled ? hintId : undefined}
          onClick={onSwitch}
        >
          {switchLabel}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          {copy.dismiss}
        </Button>
      </div>
    </section>
  );
}
