import { useId } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import './GuidedFailedBanner.css';

export interface GuidedFailedBannerProps {
  detail?: string | null;
  /** Supply only when the current run can be stopped for replan. */
  onStopAndReplan?: () => void;
  busy?: boolean;
}

/** A presentational leaf: its parent owns the run state and all API calls. */
export function GuidedFailedBanner({ detail, onStopAndReplan, busy = false }: GuidedFailedBannerProps) {
  const { messages } = useI18n();
  const copy = messages.guided.m3.failed;
  const titleId = useId();

  return (
    <section className="guided-failed-banner" role="alert" aria-labelledby={titleId}>
      <div className="guided-failed-banner__content">
        <h2 id={titleId}>{copy.title}</h2>
        <p>{copy.description}</p>
        <p className="guided-failed-banner__detail"><strong>{copy.details}:</strong> {detail?.trim() || copy.noDetails}</p>
        {onStopAndReplan ? <p>{copy.replanHint}</p> : null}
      </div>
      {onStopAndReplan ? (
        <Button variant="destructive" disabled={busy} onClick={onStopAndReplan}>
          {busy ? copy.stopping : copy.replan}
        </Button>
      ) : null}
    </section>
  );
}
