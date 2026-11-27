import type { RunLineageFields, RunStatus } from '../../api/client';
import { useI18n } from '../../i18n';
import './LineageSummary.css';

export interface LineageSummaryProps {
  runId: string;
  status: RunStatus | (string & {});
  lineage: RunLineageFields;
  /** Drift baseline supplied from the root run's recorded start SHA. */
  rootStartSha: string | null;
  currentBaseSha: string | null;
  mergedSha?: string | null;
}

const MISSING_SHA = '—';

/** Display only the conventional short form; the full value stays in the title. */
function shortSha(value: string | null): string | null {
  return value ? value.slice(0, 7) : null;
}

/** A presentational leaf: its parent owns the run state and all API calls. */
export function LineageSummary({
  runId,
  status,
  lineage,
  rootStartSha,
  currentBaseSha,
  mergedSha,
}: LineageSummaryProps) {
  const { messages } = useI18n();
  const copy = messages.guided.m3.signOff;
  const driftCopy = messages.guided.m3.drift;

  const parentRunId = lineage.parent_run_id?.trim() || null;
  const baseRef = lineage.base_ref?.trim() || null;
  const startSha = lineage.start_sha?.trim() || null;
  const resultSha = lineage.result_sha?.trim() || null;
  const merged = mergedSha?.trim() || null;
  const currentBase = currentBaseSha?.trim() || null;
  // A revision's start SHA is the parent's result, not the base baseline.
  const baseSha = rootStartSha?.trim() || (parentRunId ? null : startSha);
  const showBase = Boolean(baseSha || baseRef);
  // A merge advances the base to the merged commit; only a pre-merge head can drift.
  const drifted = Boolean(
    !merged && baseSha && currentBase && baseSha.toLowerCase() !== currentBase.toLowerCase(),
  );

  return (
    <section className="guided-lineage-summary" aria-label={`${copy.currentRun}: ${runId}`}>
      <ol className="guided-lineage-summary__chain">
        {showBase ? (
          <li className="guided-lineage-summary__node" data-node="base">
            <span className="guided-lineage-summary__label">{copy.baseSha}</span>
            <code className="guided-lineage-summary__sha" title={baseSha ?? undefined}>
              {shortSha(baseSha) ?? MISSING_SHA}
            </code>
            {baseRef ? (
              <span className="guided-lineage-summary__ref">
                {copy.baseBranch}: <code>{baseRef}</code>
              </span>
            ) : null}
          </li>
        ) : null}

        {parentRunId ? (
          <li className="guided-lineage-summary__node" data-node="parent">
            <span className="guided-lineage-summary__label">{copy.parentRun}</span>
            <code className="guided-lineage-summary__run" title={parentRunId}>{parentRunId}</code>
            <span className="guided-lineage-summary__label">{copy.resultSha}</span>
            <code className="guided-lineage-summary__sha" title={startSha ?? undefined}>
              {shortSha(startSha) ?? MISSING_SHA}
            </code>
          </li>
        ) : null}

        <li className="guided-lineage-summary__node" data-node="current">
          <span className="guided-lineage-summary__label">{copy.currentRun}</span>
          <code className="guided-lineage-summary__run" title={runId}>{runId}</code>
          <span className="guided-lineage-summary__status" data-status={status}>{status}</span>
          <span className="guided-lineage-summary__label">{copy.resultSha}</span>
          <code className="guided-lineage-summary__sha" title={resultSha ?? undefined}>
            {shortSha(resultSha) ?? MISSING_SHA}
          </code>
        </li>
      </ol>

      {merged ? (
        <p className="guided-lineage-summary__merged" data-merged="true">
          <span className="guided-lineage-summary__label">{copy.mergedSha}</span>
          <code className="guided-lineage-summary__sha" title={merged}>{shortSha(merged)}</code>
        </p>
      ) : null}

      {drifted ? (
        <div className="guided-lineage-summary__drift" data-state="drift" role="status">
          <strong>{driftCopy.title}</strong>
          <p>{driftCopy.description}</p>
          <p className="guided-lineage-summary__current-base">
            <span className="guided-lineage-summary__label">{copy.currentBaseSha}</span>
            <code className="guided-lineage-summary__sha" title={currentBase ?? undefined}>
              {shortSha(currentBase) ?? MISSING_SHA}
            </code>
          </p>
        </div>
      ) : null}
    </section>
  );
}
