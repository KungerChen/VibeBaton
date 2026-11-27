import { useId } from 'react';
import type { CliRegistryScanResponse, CliScanStatus } from '../../api/client';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import './CliSummaryBar.css';

export interface CliSummaryBarProps {
  scan: CliRegistryScanResponse['scan'] | null;
  scanning: boolean;
  onScan(): void;
  onOpenDetails(): void;
}

function countStatuses(scan: CliRegistryScanResponse['scan'] | null): Record<CliScanStatus, number> {
  const counts: Record<CliScanStatus, number> = {
    ready: 0,
    installed_unauthenticated: 0,
    missing: 0,
    prereq_missing: 0,
  };
  for (const entry of scan?.drivers ?? []) counts[entry.status] += 1;
  return counts;
}

/** A presentational leaf: its parent owns the scan, the details panel and all API calls. */
export function CliSummaryBar({ scan, scanning, onScan, onOpenDetails }: CliSummaryBarProps) {
  const { messages } = useI18n();
  const copy = messages.guided.m3.cliSummary;
  const titleId = useId();
  const counts = countStatuses(scan);
  const empty = !scan || scan.drivers.length === 0;

  return (
    <section className="cli-summary-bar" aria-labelledby={titleId}>
      <h2 className="cli-summary-bar__title" id={titleId}>{copy.title}</h2>
      {scan ? (
        <ul className="cli-summary-bar__counts">
          <li className="cli-summary-bar__count" data-status="ready" data-count={counts.ready}>
            <span>{copy.ready}</span>
            <strong>{counts.ready}</strong>
          </li>
          <li className="cli-summary-bar__count" data-status="installed_unauthenticated" data-count={counts.installed_unauthenticated}>
            <span>{copy.needsSignIn}</span>
            <strong>{counts.installed_unauthenticated}</strong>
          </li>
          <li className="cli-summary-bar__count" data-status="missing" data-count={counts.missing}>
            <span>{copy.missing}</span>
            <strong>{counts.missing}</strong>
          </li>
          {counts.prereq_missing > 0 ? (
            <li className="cli-summary-bar__count" data-status="prereq_missing" data-count={counts.prereq_missing}>
              <span>{copy.prerequisite}</span>
              <strong>{counts.prereq_missing}</strong>
            </li>
          ) : null}
        </ul>
      ) : null}
      {empty ? <span className="cli-summary-bar__empty">{copy.empty}</span> : null}
      <div className="cli-summary-bar__actions">
        <Button size="sm" variant="ghost" disabled={scanning} onClick={onScan}>
          {scanning ? copy.scanning : scan ? copy.rescan : copy.scan}
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpenDetails}>{copy.details}</Button>
      </div>
    </section>
  );
}
