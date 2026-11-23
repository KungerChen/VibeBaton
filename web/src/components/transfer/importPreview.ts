import type { detectTransferInput } from '../../engine/caseReplay';
import { formatDurationSec } from '../../engine/liveClock';
import { validateGraph } from '../../engine/localSimulator';
import type { Locale } from '../../i18n/messages';

export interface ImportPreview {
  typeBadge: 'recipe' | 'case';
  name: string;
  nodeCount: number;
  edgeCount: number;
  validationOk: boolean;
  validationErrors: string[];
  redactionClean?: boolean;
  durationLabel?: string;
  taskSummary?: string;
  warnings: string[];
  overwriteWarningKey?: 'transfer.importModal.overwriteWarning';
}

export function buildImportPreview(
  result: ReturnType<typeof detectTransferInput> | null,
  locale: Locale,
  canvasDirty = false,
): ImportPreview {
  const overwriteWarning = canvasDirty
    ? { overwriteWarningKey: 'transfer.importModal.overwriteWarning' as const }
    : {};
  if (!result || result.kind === 'invalid') {
    return {
      // Keep the default action label while detection is unsuccessful.
      typeBadge: 'recipe',
      name: '',
      nodeCount: 0,
      edgeCount: 0,
      validationOk: false,
      validationErrors: result?.errors ?? [],
      warnings: [],
      ...overwriteWarning,
    };
  }

  const graph = result.kind === 'case' ? result.bundle.graph : result.graph;
  const preview: ImportPreview = {
    typeBadge: result.kind,
    name: graph.name || graph.id,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    validationOk: true,
    validationErrors: [],
    warnings: validateGraph(graph).warnings,
    ...overwriteWarning,
  };
  if (result.kind === 'recipe') return preview;

  const { title, meta, redaction_report } = result.bundle;
  return {
    ...preview,
    name: title || preview.name,
    redactionClean: redaction_report.clean,
    durationLabel: formatDurationSec(meta.elapsed_sec, locale),
    taskSummary: `${meta.tasks_passed}/${meta.tasks_total}`,
  };
}
