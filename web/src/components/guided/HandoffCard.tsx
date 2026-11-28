import './HandoffCard.css';
import { useState } from 'react';
import { ApiError, type ArtifactText, type HandoffInvocation, type RunArtifactResponse, type RunHandoff } from '../../api/client';
import { formatDurationSec } from '../../engine/liveClock';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { translateRole } from '../../i18n/presets';
import { DrawerDetails } from './ContextDrawer';
import { localizeGuidedError } from './guidedErrors';

export interface HandoffCardProps {
  runId: string;
  /** The server's record of this edge; null when it lists none (panel lines, or not loaded yet). */
  handoff: RunHandoff | null;
  fromLabel: string;
  toLabel: string;
  locale: Locale;
  loadArtifact(artifactKey: string): Promise<RunArtifactResponse>;
}

type Part = 'prompt' | 'output';
type ArtifactState =
  | { phase: 'loading' }
  | { phase: 'ready'; response: RunArtifactResponse }
  | { phase: 'missing' }
  | { phase: 'error'; message: string };

/**
 * One relay line: who handed over to whom and what the events recorded of it. Every value is the
 * recorded one or says so; nothing is filled in from the plan.
 */
export function HandoffCard({ handoff, fromLabel, toLabel, locale, loadArtifact }: HandoffCardProps) {
  const copy = MESSAGES[locale].guided;
  const relay = copy.relay;
  const card = relay.handoff;
  const [shown, setShown] = useState<{ eventId: number; part: Part } | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactState>>({});
  const recorded = handoff?.recorded === true;

  function open(call: HandoffInvocation, part: Part) {
    const key = call.artifact_key;
    if (!key) return;
    if (shown?.eventId === call.event_id && shown.part === part) { setShown(null); return; }
    setShown({ eventId: call.event_id, part });
    if (artifacts[key] && artifacts[key].phase !== 'error') return;
    setArtifacts((all) => ({ ...all, [key]: { phase: 'loading' } }));
    loadArtifact(key).then(
      (response) => setArtifacts((all) => ({ ...all, [key]: { phase: 'ready', response } })),
      (failure: unknown) => setArtifacts((all) => ({ ...all, [key]: failure instanceof ApiError && failure.status === 404
        ? { phase: 'missing' } : { phase: 'error', message: localizeGuidedError(failure, locale) } })),
    );
  }

  function artifactText(call: HandoffInvocation) {
    if (!shown || shown.eventId !== call.event_id || !call.artifact_key) return null;
    const state = artifacts[call.artifact_key];
    if (!state || state.phase === 'loading') return <p className="handoff-card__muted">{card.loading}</p>;
    if (state.phase === 'error') return <p className="handoff-card__error" role="alert">{state.message}</p>;
    const part: ArtifactText | null = state.phase === 'ready' ? state.response[shown.part] : null;
    if (!part) return <p className="handoff-card__muted">{relay.notRecorded}</p>;
    return (
      <>
        {part.truncated ? <p className="handoff-card__muted">{card.truncated}</p> : null}
        <pre className="handoff-card__text">{part.text}</pre>
      </>
    );
  }

  const time = recorded && handoff?.at != null
    ? new Date(handoff.at * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' }) : null;
  const invocations = handoff?.invocations ?? [];
  const files = handoff ? handoff.changed_files : null;
  const receipts = handoff?.receipts ?? [];
  const review = handoff?.review ?? null;
  const takeover = handoff?.takeover ?? { status: null, holder: null };

  return (
    <div className="handoff-card" data-recorded={recorded}>
      <header className="context-drawer__head">
        <p className="context-drawer__eyebrow">{card.eyebrow}</p>
        <h2 className="context-drawer__title">{fromLabel} → {toLabel}</h2>
      </header>
      <div className="context-drawer__upper">
        <p className={recorded ? 'handoff-card__status handoff-card__status--recorded' : 'handoff-card__status'} data-field="record">
          {recorded ? card.recorded(time ?? relay.unknown) : card.unknownStatus}
        </p>
        <p>{recorded ? card.recordedSummary(fromLabel, toLabel) : card.unknownSummary}</p>
      </div>
      <DrawerDetails panel="handoff" locale={locale}>
        <section className="handoff-card__section">
          <h3>{card.deliverables}</h3>
          {invocations.length ? (
            <ul className="handoff-card__list" data-field="deliverables">
              {invocations.map((call) => (
                <li key={call.event_id} data-field="invocation">
                  <p><span className="context-drawer__label">{card.sides[call.side]}</span> <strong>{translateRole(call.role, locale)}</strong></p>
                  <p className="handoff-card__muted">
                    {copy.nodeDetail.model}: <code>{call.model || relay.unknown}</code>{' · '}
                    {card.callStatus}: {call.status ?? relay.unknown}{' · '}
                    {copy.nodeDetail.elapsed}: {call.duration_sec != null ? formatDurationSec(call.duration_sec, locale) : relay.unknown}
                  </p>
                  {call.artifact_key ? (
                    <div className="handoff-card__actions">
                      <button type="button" className="context-drawer__button" onClick={() => open(call, 'prompt')}>{card.viewPrompt}</button>
                      <button type="button" className="context-drawer__button" onClick={() => open(call, 'output')}>{card.viewOutput}</button>
                    </div>
                  ) : <p className="handoff-card__muted">{relay.notRecorded}</p>}
                  {artifactText(call)}
                </li>
              ))}
            </ul>
          ) : <p data-field="deliverables">{relay.unknown}</p>}
        </section>

        <section className="handoff-card__section">
          <h3>{card.changedFiles}</h3>
          {files === null ? <p data-field="changed-files">{relay.unknown}</p>
            : files.length === 0 ? <p data-field="changed-files">{card.noChangedFiles}</p>
              : <ul className="handoff-card__list" data-field="changed-files">{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>}
        </section>

        <section className="handoff-card__section">
          <h3>{card.gates}</h3>
          {receipts.length ? (
            <ul className="handoff-card__list">
              {receipts.map((receipt) => {
                const passed = receipt.exit_code === 0;
                return (
                  <li key={receipt.event_id} data-field="receipt" data-passed={passed}>
                    <code>{receipt.command}</code>
                    <p>
                      <strong className={passed ? 'handoff-card__pass' : 'handoff-card__fail'}>
                        {passed ? card.receiptPassed : card.receiptFailed}
                      </strong>{' · '}{card.exitCode(receipt.exit_code)}{' · '}{card.scopes[receipt.scope]} <code>{receipt.target_id}</code>
                    </p>
                    {receipt.output_tail ? (
                      <details>
                        <summary>{card.outputTail}</summary>
                        <pre className="handoff-card__text">{receipt.output_tail}</pre>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : <p className="handoff-card__muted" data-field="receipts">{card.noReceipts}</p>}
        </section>

        <section className="handoff-card__section">
          <h3>{card.review}</h3>
          {review ? (
            <div data-field="review">
              <p><strong>{copy.nodeDetail.verdicts[review.verdict] ?? review.verdict}</strong>{' · '}{card.reviewer} <code>{review.reviewer || relay.unknown}</code></p>
              {review.summary ? <p>{review.summary}</p> : null}
            </div>
          ) : <p data-field="review">{relay.unknown}</p>}
        </section>

        <section className="handoff-card__section">
          <h3>{card.takeover}</h3>
          <dl className="context-drawer__facts">
            <dt>{card.takeoverStatus}</dt>
            <dd data-field="takeover-status">{takeover.status ? copy.nodeDetail.statuses[takeover.status] ?? takeover.status : relay.unknown}</dd>
            <dt>{card.takeoverHolder}</dt>
            <dd data-field="takeover-holder">{takeover.holder ? translateRole(takeover.holder, locale) : relay.unknown}</dd>
          </dl>
        </section>

        <section className="handoff-card__section">
          <h3>{card.blocked}</h3>
          <p data-field="blocked">{handoff?.blocked_reason || card.noBlocked}</p>
        </section>
      </DrawerDetails>
    </div>
  );
}
