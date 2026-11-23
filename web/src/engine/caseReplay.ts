import { flagship_4tier } from '../data/presets';
import { getStage1ReplayTrace, STAGE1_REPLAY_META } from '../data/stage1Replay';
import { MESSAGES, type Locale } from '../i18n/messages';
import type {
  BatonCaseBundle,
  CaseRedactionReport,
  CaseReplayMeta,
  GraphTraceEvent,
  TraceKind,
  WorkflowEdge,
  WorkflowGraph,
} from '../types/graph';
import { formatDurationSec } from './liveClock';
import { validateGraph } from './localSimulator';
import { decodeRecipeHash, RECIPE_HASH_PREFIX } from './shareUrl';

export const OFFICIAL_STAGE1_CASE_ID = 'official-stage1';
export const SAVED_CASES_KEY = 'vibebaton.importedCases.v1';
export const SAVED_CASES_CAP = 10;

const CASE_SCHEMA_VERSION = 'baton-case/v1';
const TRACE_KINDS: readonly TraceKind[] = [
  'node_started', 'node_completed', 'node_failed', 'edge_traversed',
  'loop_limit_reached', 'graph_completed', 'graph_halted',
];

const CREDENTIAL_PATTERN = /sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const EMAIL_PATTERN = /(?:^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

type WireCaseModel = string | { provider: string; model: string };
type WireCaseMeta = Omit<CaseReplayMeta, 'models'> & { models: WireCaseModel[] };
type ImportedEdge = Omit<WorkflowEdge, 'max_loops'> & {
  source_handle?: string;
  target_handle?: string;
  max_loops?: number | boolean | null;
  maxLoops?: number | boolean | null;
};

type CaseParseResult = { ok: true; bundle: BatonCaseBundle; warnings: string[] } | { ok: false; errors: string[] };
type TransferInput =
  | { kind: 'case'; bundle: BatonCaseBundle }
  | { kind: 'recipe'; graph: WorkflowGraph }
  | { kind: 'invalid'; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWireCaseModel(value: unknown): value is WireCaseModel {
  return typeof value === 'string' || (
    isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string'
  );
}

function isWireCaseMeta(value: unknown): value is WireCaseMeta {
  return isRecord(value)
    && typeof value.source_run_id === 'string'
    && typeof value.status === 'string'
    && Number.isFinite(value.elapsed_sec)
    && Number.isFinite(value.milestones_passed)
    && Number.isFinite(value.milestones_total)
    && Number.isFinite(value.tasks_passed)
    && Number.isFinite(value.tasks_total)
    && Number.isFinite(value.gate_catches)
    && Number.isFinite(value.whitelist_catches)
    && Number.isFinite(value.escalations)
    && Array.isArray(value.models) && value.models.every(isWireCaseModel)
    && Array.isArray(value.stages)
    && isRecord(value.billing);
}

function isRedactionReport(value: unknown): value is CaseRedactionReport {
  return isRecord(value)
    && Number.isFinite(value.secrets_redacted)
    && Number.isFinite(value.paths_anonymized)
    && Number.isFinite(value.emails_redacted)
    && Number.isFinite(value.ips_redacted)
    && Number.isFinite(value.raw_diff_stripped)
    && Number.isFinite(value.raw_stack_stripped)
    && typeof value.clean === 'boolean';
}

function isTraceEvent(value: unknown): value is GraphTraceEvent {
  return isRecord(value)
    && Number.isFinite(value.seq)
    && Number.isFinite(value.timestamp)
    && TRACE_KINDS.some((kind) => kind === value.kind)
    && (value.node_id === null || typeof value.node_id === 'string')
    && (value.edge_id === null || typeof value.edge_id === 'string')
    && (value.outcome === null || typeof value.outcome === 'string')
    && typeof value.message === 'string';
}

// Normalize legacy handles and loop limits for the canvas.
function canonicalizeEdge(input: ImportedEdge): WorkflowEdge {
  const {
    source_handle,
    target_handle,
    maxLoops,
    sourceHandle = source_handle,
    targetHandle = target_handle,
    max_loops = maxLoops,
    ...rest
  } = input;
  const edge: WorkflowEdge = rest;
  if (sourceHandle !== undefined) edge.sourceHandle = sourceHandle;
  if (targetHandle !== undefined) edge.targetHandle = targetHandle;
  if (max_loops != null) edge.max_loops = Number(max_loops);
  return edge;
}

function parseTransferGraph(input: unknown): { graph: WorkflowGraph } | { errors: string[] } {
  // validateGraph checks the required fields of the incoming JSON.
  const graph = input as WorkflowGraph;
  const validation = validateGraph(graph);
  if (!validation.valid) return { errors: validation.errors };

  const badRoleIndex = graph.nodes.findIndex(({ role }) => role !== undefined && typeof role !== 'string');
  if (badRoleIndex !== -1) return { errors: [MESSAGES.en.sidebar.roleMustBeString(badRoleIndex)] };
  return { graph: { ...graph, edges: graph.edges.map(canonicalizeEdge) } };
}

function scanResidualSecrets(raw: Record<string, unknown>): string[] {
  const pending: unknown[] = [raw];
  const visited = new WeakSet<object>();
  let hasCredential = false;
  let hasEmail = false;

  while (pending.length > 0 && !(hasCredential && hasEmail)) {
    const value = pending.pop();
    if (typeof value === 'string') {
      hasCredential ||= CREDENTIAL_PATTERN.test(value);
      hasEmail ||= EMAIL_PATTERN.test(value);
    } else if (typeof value === 'object' && value !== null && !visited.has(value)) {
      visited.add(value);
      for (const [key, entry] of Object.entries(value)) {
        pending.push(key, entry);
      }
    }
  }

  const warnings: string[] = [];
  if (hasCredential) warnings.push('Possible residual credential in the case bundle.');
  if (hasEmail) warnings.push('Possible email address in the case bundle.');
  return warnings;
}

/** Check the format marker. Use parseAndValidateCaseBundle before reading case fields. */
export function isCaseBundleInput(parsed: unknown): parsed is BatonCaseBundle {
  return isRecord(parsed) && parsed.schema_version === CASE_SCHEMA_VERSION;
}

export function parseAndValidateCaseBundle(raw: unknown): CaseParseResult {
  if (!isRecord(raw) || raw.schema_version !== CASE_SCHEMA_VERSION) {
    return { ok: false, errors: ['Case bundle must have schema_version baton-case/v1.'] };
  }

  const { case_id, title, summary, created_at, meta, redaction_report, trace, isOfficialTutorial } = raw;
  if (typeof case_id !== 'string' || !case_id.trim()
    || typeof title !== 'string' || typeof summary !== 'string' || typeof created_at !== 'string') {
    return { ok: false, errors: ['Case bundle requires case_id, title, summary, and created_at strings.'] };
  }
  if (isOfficialTutorial !== undefined && typeof isOfficialTutorial !== 'boolean') {
    return { ok: false, errors: ['isOfficialTutorial must be a boolean.'] };
  }
  if (!isWireCaseMeta(meta)) {
    return { ok: false, errors: ['Case meta requires run metrics, models, stages, and billing.'] };
  }
  if (!isRedactionReport(redaction_report)) {
    return { ok: false, errors: ['Case redaction_report requires all redaction counts and a clean flag.'] };
  }

  const result = parseTransferGraph(raw.graph);
  if ('errors' in result) return { ok: false, errors: result.errors };

  if (!Array.isArray(trace) || trace.length === 0) {
    return { ok: false, errors: ['Case trace must contain at least one event.'] };
  }
  if (!trace.every(isTraceEvent)) {
    return { ok: false, errors: ['Each trace event requires a numeric seq and timestamp, a kind, and replay fields.'] };
  }

  const warnings = scanResidualSecrets(raw);
  return {
    ok: true,
    bundle: {
      ...raw,
      schema_version: CASE_SCHEMA_VERSION,
      case_id,
      title,
      summary,
      created_at,
      meta: { ...meta, models: meta.models.map((model) => typeof model === 'string' ? model : model.model) },
      // A residual-secret warning also reaches callers that consume only the bundle.
      redaction_report: { ...redaction_report, clean: redaction_report.clean && warnings.length === 0 },
      graph: result.graph,
      trace,
    },
    warnings,
  };
}

export function detectTransferInput(text: string): TransferInput {
  const input = text.trim();
  let hash = input.startsWith(RECIPE_HASH_PREFIX) ? input : '';
  if (!hash) {
    try {
      hash = new URL(input).hash;
    } catch {
      // A JSON payload has no URL fragment.
    }
  }

  const recipe = decodeRecipeHash(hash);
  if (recipe) {
    return 'graph' in recipe
      ? { kind: 'recipe', graph: { ...recipe.graph, edges: recipe.graph.edges.map(canonicalizeEdge) } }
      : { kind: 'invalid', errors: [recipe.error] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { kind: 'invalid', errors: ['Enter a recipe, replay case, or recipe share link.'] };
  }
  if (isCaseBundleInput(parsed) || (
    isRecord(parsed) && typeof parsed.schema_version === 'string' && parsed.schema_version.startsWith('baton-case/')
  )) {
    const result = parseAndValidateCaseBundle(parsed);
    return result.ok
      ? { kind: 'case', bundle: result.bundle }
      : { kind: 'invalid', errors: result.errors };
  }

  const result = parseTransferGraph(parsed);
  return 'graph' in result
    ? { kind: 'recipe', graph: result.graph }
    : { kind: 'invalid', errors: result.errors };
}

export function buildOfficialStage1Case(locale: Locale): BatonCaseBundle {
  const replay = STAGE1_REPLAY_META;
  const [milestonesPassed, milestonesTotal] = replay.milestones.split('/').map(Number);
  const [tasksPassed, tasksTotal] = replay.tasks.split('/').map(Number);
  const models = flagship_4tier.nodes.flatMap(({ config }) => (
    typeof config?.model === 'string' ? [config.model] : []
  ));

  return {
    schema_version: CASE_SCHEMA_VERSION,
    case_id: OFFICIAL_STAGE1_CASE_ID,
    title: locale === 'zh' ? '一期自举（v0.2.0）' : replay.title,
    summary: locale === 'zh' ? 'VibeBaton 一期自举运行回放。' : 'Replay of the Stage 1 VibeBaton self-hosting run.',
    // The source run ID records the start as local time.
    created_at: '2026-11-21T04:44:54',
    meta: {
      source_run_id: replay.runId,
      status: 'COMPLETED',
      elapsed_sec: replay.elapsedSec,
      milestones_passed: milestonesPassed,
      milestones_total: milestonesTotal,
      tasks_passed: tasksPassed,
      tasks_total: tasksTotal,
      gate_catches: replay.gateCatches,
      whitelist_catches: replay.whitelistCatches,
      escalations: replay.escalations,
      models: [...new Set(models)],
      stages: [],
      billing: {},
    },
    redaction_report: {
      secrets_redacted: 0,
      paths_anonymized: 0,
      emails_redacted: 0,
      ips_redacted: 0,
      raw_diff_stripped: 0,
      raw_stack_stripped: 0,
      clean: true,
    },
    graph: structuredClone(flagship_4tier),
    trace: structuredClone(getStage1ReplayTrace(locale)),
    isOfficialTutorial: true,
  };
}

function limitSavedCases(cases: Iterable<BatonCaseBundle>): BatonCaseBundle[] {
  const byId = new Map<string, BatonCaseBundle>();
  for (const bundle of cases) {
    if (!byId.has(bundle.case_id)) byId.set(bundle.case_id, bundle);
    if (byId.size === SAVED_CASES_CAP) break;
  }
  return [...byId.values()];
}

function* validSavedCases(values: unknown[]): Generator<BatonCaseBundle> {
  for (const value of values) {
    const result = parseAndValidateCaseBundle(value);
    if (result.ok) yield result.bundle;
  }
}

export function readSavedCases(storage?: Pick<Storage, 'getItem'>): BatonCaseBundle[] {
  try {
    const saved = (storage ?? globalThis.localStorage)?.getItem(SAVED_CASES_KEY);
    if (!saved) return [];
    const values: unknown = JSON.parse(saved);
    return Array.isArray(values) ? limitSavedCases(validSavedCases(values)) : [];
  } catch {
    return [];
  }
}

export function writeSavedCases(cases: readonly BatonCaseBundle[], storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(SAVED_CASES_KEY, JSON.stringify(limitSavedCases(cases)));
  } catch {
    // Replay can continue when storage is unavailable or full.
  }
}

/** Put the most recently imported case first, regardless of its original run date. */
export function upsertSavedCase(cases: readonly BatonCaseBundle[], bundle: BatonCaseBundle): BatonCaseBundle[] {
  try {
    return limitSavedCases([bundle, ...cases]);
  } catch {
    return [];
  }
}

export function caseSummaryPill(bundle: BatonCaseBundle, locale: Locale): string {
  const { elapsed_sec, tasks_passed, tasks_total } = bundle.meta;
  return MESSAGES[locale].transfer.playback.summaryPill(
    formatDurationSec(elapsed_sec, locale),
    tasks_passed,
    tasks_total,
    { separator: ' · ', clean: bundle.redaction_report.clean },
  );
}
