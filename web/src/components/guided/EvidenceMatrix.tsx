import './EvidenceMatrix.css';
import { useEffect, useState } from 'react';
import type { EvidenceCriterion, GateReceipt, RunEvidenceResponse } from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';

export type EvidenceLoader = (runId: string) => Promise<RunEvidenceResponse>;

/** The four ways a cell reads; only a receipt whose latest result has exit code 0 is "passed". */
export type EvidenceCell = 'receipt_passed' | 'receipt_failed' | 'files_only' | 'not_linked';

/**
 * What a criterion's cell shows. A row counts as passed only with a receipt and a recorded pass;
 * changed files alone and rows without a link stay neutral.
 */
export function evidenceCell(criterion: Pick<EvidenceCriterion, 'state' | 'result' | 'receipts'>): EvidenceCell {
  if (criterion.state === 'receipt' && criterion.receipts.length > 0) {
    return criterion.result === 'passed' && latestReceipts(criterion.receipts).every((receipt) => receipt.exit_code === 0)
      ? 'receipt_passed' : 'receipt_failed';
  }
  return criterion.state === 'files_only' ? 'files_only' : 'not_linked';
}

/** The latest receipt of each command, in the order the commands first ran. */
function latestReceipts(receipts: readonly GateReceipt[]): GateReceipt[] {
  const latest = new Map<string, GateReceipt>();
  for (const receipt of receipts) latest.set(receipt.command, receipt);
  return [...latest.values()];
}

function ReceiptList({ receipts, locale }: { receipts: readonly GateReceipt[]; locale: Locale }) {
  const card = MESSAGES[locale].guided.relay.handoff;
  return (
    <ul className="evidence-matrix__receipts">
      {receipts.map((receipt) => {
        const passed = receipt.exit_code === 0;
        return (
          <li key={receipt.event_id} data-field="receipt" data-passed={passed}>
            <code>{receipt.command}</code>
            <p>
              <strong className={passed ? 'evidence-matrix__pass' : 'evidence-matrix__fail'}>
                {passed ? card.receiptPassed : card.receiptFailed}
              </strong>{' · '}{card.exitCode(receipt.exit_code)}{' · '}{card.scopes[receipt.scope]} <code>{receipt.target_id}</code>
            </p>
            {receipt.output_tail ? (
              <details>
                <summary>{card.outputTail}</summary>
                <pre className="evidence-matrix__output">{receipt.output_tail}</pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The matrix itself: one row per criterion with one evidence cell, the summary, and the run-level receipts. */
export function EvidenceTable({ evidence, locale }: { evidence: RunEvidenceResponse; locale: Locale }) {
  const copy = MESSAGES[locale].guided.evidence;
  const cells = evidence.criteria.map(evidenceCell);
  const passed = cells.filter((cell) => cell === 'receipt_passed').length;
  const failed = cells.filter((cell) => cell === 'receipt_failed').length;
  const anyReceipt = evidence.run_level_receipts.length > 0 || evidence.criteria.some((row) => row.receipts.length > 0);
  return (
    <>
      {evidence.criteria.length > 0 ? (
        <>
          <p className="evidence-matrix__summary" data-field="summary">{copy.summary(passed, failed, evidence.criteria.length)}</p>
          <table className="evidence-matrix__table">
            <thead>
              <tr><th scope="col">{copy.criterion}</th><th scope="col">{copy.evidenceColumn}</th></tr>
            </thead>
            <tbody>
              {evidence.criteria.map((row, index) => {
                const cell = cells[index];
                return (
                  <tr key={`${row.index}-${index}`} data-criterion={row.index} data-cell={cell}>
                    <th scope="row"><span className="evidence-matrix__index">{row.index}.</span> {row.text}</th>
                    <td>
                      <span className="evidence-matrix__state" data-cell={cell}>{copy.states[cell]}</span>
                      {cell === 'files_only' ? <p className="evidence-matrix__note">{copy.filesOnlyNote}</p> : null}
                      {cell === 'not_linked' ? <p className="evidence-matrix__note">{copy.notLinkedNote}</p> : null}
                      {row.receipts.length > 0 ? (
                        <details>
                          <summary>{copy.receipts(row.receipts.length)}</summary>
                          <ReceiptList receipts={row.receipts} locale={locale} />
                        </details>
                      ) : null}
                      {row.files.length > 0 ? (
                        <p className="evidence-matrix__files">{copy.files} {row.files.map((file) => <code key={file}>{file}</code>)}</p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : <p className="evidence-matrix__note" data-field="no-criteria">{evidence.rfc_available ? copy.noCriteria : copy.noRfc}</p>}
      {anyReceipt ? null : <p className="evidence-matrix__note" data-field="no-receipts">{copy.noReceiptsAtAll}</p>}
      <div className="evidence-matrix__run-level" data-field="run-level">
        <h4>{copy.runLevel}</h4>
        <p className="evidence-matrix__note">{copy.runLevelNote}</p>
        {evidence.run_level_receipts.length > 0
          ? <ReceiptList receipts={evidence.run_level_receipts} locale={locale} />
          : <p className="evidence-matrix__note">{copy.noRunLevel}</p>}
      </div>
    </>
  );
}

type LoadState =
  | { runId: string; phase: 'ready'; evidence: RunEvidenceResponse }
  | { runId: string; phase: 'error' };

/**
 * Sign-Off evidence matrix: the acceptance criteria of the run's own blueprint against its gate receipts.
 * It repeats recorded facts only; a link exists only where the criterion names the command or the file itself.
 */
export function EvidenceMatrix({ runId, runStatus, locale, loader }: {
  runId: string;
  /** Read again when the run's status changes (an approval can add final-gate receipts). */
  runStatus?: string;
  locale: Locale;
  loader: EvidenceLoader;
}) {
  const copy = MESSAGES[locale].guided.evidence;
  const [state, setState] = useState<LoadState | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    loader(runId).then(
      (evidence) => { if (active) setState({ runId, phase: 'ready', evidence }); },
      () => { if (active) setState({ runId, phase: 'error' }); },
    );
    return () => { active = false; };
  }, [loader, runId, runStatus, attempt]);

  const current = state?.runId === runId ? state : null;
  return (
    <section className="evidence-matrix" aria-label={copy.title}>
      <h3 className="evidence-matrix__title">{copy.title}</h3>
      <p className="evidence-matrix__note">{copy.note}</p>
      {current === null ? <p className="evidence-matrix__note" role="status">{copy.loading}</p>
        : current.phase === 'error' ? (
          <p className="evidence-matrix__note" role="alert">
            {copy.failed}{' '}
            <button type="button" className="evidence-matrix__retry" onClick={() => setAttempt((count) => count + 1)}>{copy.retry}</button>
          </p>
        ) : <EvidenceTable evidence={current.evidence} locale={locale} />}
    </section>
  );
}
