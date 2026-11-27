import './GuidedBrainstormStep.css';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  ApiError,
  BatonApiClient,
  type BlueprintCard,
  type BlueprintConfirmResult,
  type BrainstormChatRequest,
  type BrainstormMessage,
  type BrainstormTurnResult,
  type ChecklistId,
  type ChecklistItem,
  type GuidedLaunchRunRequest,
  type GuidedSession,
  type L0ModelsResult,
  type ModelCatalogResponse,
  type ProjectSize,
  type RecommendedLineup,
  type SavedLineupProfile,
  type WorkflowLineup,
  type WorkflowMode,
  type WorkflowRecommendation,
} from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { checkRfcReadiness } from '../../api/offlineRfc';
import type { LaunchRunRequest } from '../../types/graph';
import { localizeGuidedError } from './guidedErrors';
import scenarioList from './brainstormScenarios.json';
import { MarkdownView } from '../ui/MarkdownView';
import { GuidedLaunchBar } from './GuidedLaunchBar';
import { BUILTIN_MODEL_CATALOG, matchSavedProfile } from './GuidedSetupStep';
import { L0ModelSwitcher } from './L0ModelSwitcher';
import { useGuidedSession, type GuidedSessionApi, type GuidedSessionState } from './useGuidedSession';

/** The three backend calls this step needs; inject a fake in tests or the App's shared client. */
export interface GuidedBrainstormApi {
  brainstormChat(payload: BrainstormChatRequest): Promise<BrainstormTurnResult>;
  brainstormConfirm(rfcMarkdown: string): Promise<BlueprintConfirmResult>;
  startRun(payload: LaunchRunRequest & {
    launch_request_id?: string; lineup?: WorkflowLineup; preset?: string | null;
  }): Promise<{ run_id: string }>;
}

export interface BrainstormScenario {
  id: string;
  title_en: string;
  title_zh: string;
  prompt_en: string;
  prompt_zh: string;
}

/** Backend `brainstorm.SCENARIOS` (src/vibebaton/brainstorm.py); a backend test keeps this JSON equal to it. */
export const BRAINSTORM_SCENARIOS: readonly BrainstormScenario[] = scenarioList;

/** Examples shown on the opening screen; the rest sit under "More ideas". */
export const FEATURED_SCENARIO_IDS: readonly string[] = ['new_feature', 'bug_fix', 'ui_redesign', 'not_sure'];

export const CHECKLIST_IDS: readonly ChecklistId[] = ['what', 'who', 'scope', 'limits', 'done'];

/** The Guided page's L0 role; its lineup choice also drives the brainstorm. */
const L0_ROLE = 'brainstorm_and_final_gate';

/** Return a new transcript with one turn appended; the input array is never mutated. */
export function appendTurn(
  messages: readonly BrainstormMessage[],
  role: BrainstormMessage['role'],
  content: string,
): BrainstormMessage[] {
  return [...messages, { role, content }];
}

/** One chat turn in the brainstorm transcript; assistant replies render as Markdown. */
export function BrainstormTurn({ message, respondingModel, modelLabel }: {
  message: BrainstormMessage; respondingModel?: string | null; modelLabel?: string;
}) {
  return (
    <li className={`guided-brainstorm__turn guided-brainstorm__turn--${message.role}`}>
      {message.role === 'assistant' ? <>
        {modelLabel ? <small className="guided-brainstorm__model">{modelLabel}: {respondingModel || MESSAGES.en.guided.m3.brainstorm.modelUnknown}</small> : null}
        <MarkdownView markdown={message.content} />
      </> : message.content}
    </li>
  );
}

/** Protect the visible online draft when a later live turn returns a retryable failure. */
export function selectBrainstormResult(previous: BrainstormTurnResult | null, incoming: BrainstormTurnResult) {
  const failed = incoming.retryable === true || (!!previous && !previous.offline && incoming.offline);
  return { turn: failed && previous ? previous : incoming, retryError: failed ? incoming.error || 'Online request failed.' : null };
}

/** Share one in-flight launch, including the persistence and key preparation. */
export function createLaunchFlight() {
  let current: Promise<string> | null = null;
  return (launch: () => Promise<string>): Promise<string> => {
    if (current) return current;
    const operation = launch();
    current = operation;
    void operation.finally(() => { if (current === operation) current = null; }).catch(() => {});
    return operation;
  };
}

/** Launch is allowed only once the backend marks the blueprint ready. */
export function canLaunch(card: BlueprintCard | null): boolean {
  return card?.ready_to_launch === true;
}

/** Send a conversation that already ends with the user turn; append the reply. */
async function chat(
  api: Pick<GuidedBrainstormApi, 'brainstormChat'>,
  withUser: BrainstormMessage[],
  scenario: string | null,
  locale?: Locale,
  lineup?: Pick<RecommendedLineup, 'roles' | 'model_overrides'>,
  context?: Pick<BrainstormChatRequest, 'requested_l0_model' | 'revision_context' | 'failure_context' | 'previous_lineup'>,
): Promise<{ messages: BrainstormMessage[]; turn: BrainstormTurnResult }> {
  const payload: BrainstormChatRequest = locale ? { messages: withUser, scenario, locale } : { messages: withUser, scenario };
  // Run the brainstorm on the L0 model picked in Workspace: its explicit spec, else just its provider.
  const l0Spec = lineup?.model_overrides?.[L0_ROLE];
  const l0Provider = lineup?.roles[L0_ROLE];
  if (context) Object.assign(payload, context);
  else if (l0Spec) payload.model_overrides = { [L0_ROLE]: l0Spec };
  else if (l0Provider) payload.role_providers = { [L0_ROLE]: l0Provider };
  const turn = await api.brainstormChat(payload);
  return { messages: appendTurn(withUser, 'assistant', turn.reply), turn };
}

/** One chat round-trip: append the user turn, ask the partner, append its reply. */
export async function sendBrainstormTurn(
  api: Pick<GuidedBrainstormApi, 'brainstormChat'>,
  messages: readonly BrainstormMessage[],
  input: string,
  scenario: string | null,
  locale?: Locale,
  lineup?: Pick<RecommendedLineup, 'roles' | 'model_overrides'>,
  context?: Pick<BrainstormChatRequest, 'requested_l0_model' | 'revision_context' | 'failure_context' | 'previous_lineup'>,
): Promise<{ messages: BrainstormMessage[]; turn: BrainstormTurnResult }> {
  return chat(api, appendTurn(messages, 'user', input), scenario, locale, lineup, context);
}

/** The transcript to resend on retry: the trailing assistant reply is dropped, the user turn is kept once. */
export function retryTranscript(messages: readonly BrainstormMessage[]): BrainstormMessage[] | null {
  const trimmed = messages[messages.length - 1]?.role === 'assistant' ? messages.slice(0, -1) : [...messages];
  return trimmed[trimmed.length - 1]?.role === 'user' ? trimmed : null;
}

/** Resend the last user turn (after a failed live turn) without adding it again. */
export async function retryBrainstormTurn(
  api: Pick<GuidedBrainstormApi, 'brainstormChat'>,
  messages: readonly BrainstormMessage[],
  scenario: string | null,
  locale?: Locale,
  lineup?: Pick<RecommendedLineup, 'roles' | 'model_overrides'>,
  context?: Pick<BrainstormChatRequest, 'requested_l0_model' | 'revision_context' | 'failure_context' | 'previous_lineup'>,
): Promise<{ messages: BrainstormMessage[]; turn: BrainstormTurnResult }> {
  const transcript = retryTranscript(messages);
  if (!transcript) throw new Error('Nothing to retry.');
  return chat(api, transcript, scenario, locale, lineup, context);
}

/**
 * Persist the RFC first, then start the run from the written file with the Ready-on-Host
 * lineup, so roles run on the providers that are actually ready; resolves to the run id.
 */
export async function confirmAndStart(
  api: Pick<GuidedBrainstormApi, 'brainstormConfirm' | 'startRun'>,
  rfcMarkdown: string,
  lineup: RecommendedLineup,
): Promise<string> {
  const { rfc_path } = await api.brainstormConfirm(rfcMarkdown);
  const { run_id } = await api.startRun({
    rfc_path,
    mode: 'overnight',
    role_providers: { ...lineup.roles },
    ...(lineup.model_overrides && Object.keys(lineup.model_overrides).length > 0
      ? { model_overrides: { ...lineup.model_overrides } }
      : {}),
  });
  return run_id;
}

// ---- Opening examples and editing -------------------------------------------------------------

/** Clicking an example fills the input unless the user already wrote something of their own. */
export function applyExample(current: string, example: string): string {
  const text = current.trim();
  const isExample = BRAINSTORM_SCENARIOS.some((item) => item.prompt_en === text || item.prompt_zh === text);
  return text === '' || isExample ? example : current;
}

/** Prefill for "Change": replaces an earlier change prefix, keeps whatever else the user typed. */
export function editPrefill(current: string, prefix: string, knownPrefixes: readonly string[]): string {
  let rest = current;
  for (const known of knownPrefixes) {
    if (rest.startsWith(known)) {
      rest = rest.slice(known.length);
      break;
    }
  }
  return prefix + rest.trimStart();
}

/** Enter sends, Shift+Enter adds a line, and nothing sends while an IME is composing. */
export function shouldSubmitOnKey(event: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

// ---- Checklist --------------------------------------------------------------------------------

/** The five items in order; missing ones count as open. */
export function normalizeChecklist(turn: BrainstormTurnResult | null): ChecklistItem[] {
  const items = new Map((turn?.guide?.checklist ?? []).map((item) => [item.id, item]));
  return CHECKLIST_IDS.map((id) => items.get(id) ?? { id, status: 'open', value: '' });
}

export function checklistProgress(items: readonly ChecklistItem[]): { clear: number; assumed: number; total: number } {
  return {
    clear: items.filter((item) => item.status === 'clear').length,
    assumed: items.filter((item) => item.status === 'assumed').length,
    total: items.length,
  };
}

/** Plain-language reason the build cannot start yet, or null when it can. */
export function notReadyReason(
  turn: BrainstormTurnResult | null,
  lineupReady: boolean,
  labels: Pick<BrainstormLabels, 'notReadyMissing' | 'notReadyCheck' | 'notReadyLineup' | 'items'>,
  separator: string,
): string | null {
  if (!turn) return null;
  if (!lineupReady) return labels.notReadyLineup;
  if (canLaunch(turn.blueprint)) return null;
  const open = normalizeChecklist(turn).filter((item) => item.status === 'open');
  if (open.length > 0) return labels.notReadyMissing(open.map((item) => labels.items[item.id]).join(separator));
  return labels.notReadyCheck;
}

// ---- Waiting and typing -----------------------------------------------------------------------

export type WaitingPhase = 'understanding' | 'drafting' | 'slow';

/** 0-5 s: reading the idea; then drafting (usually 10-40 s); past 45 s: slower than usual. */
export function waitingPhase(elapsedMs: number): WaitingPhase {
  if (elapsedMs < 5000) return 'understanding';
  if (elapsedMs < 45000) return 'drafting';
  return 'slow';
}

export const TYPEWRITER_MIN_MS = 2000;
export const TYPEWRITER_MAX_MS = 4000;
const TYPEWRITER_MAX_FRAMES = 60;
// One CJK character, a run of whitespace, or a word with its trailing spaces.
const TYPEWRITER_TOKEN = /[　-鿿＀-￯]|\s+|[^\s　-鿿＀-￯]+\s*/g;

/**
 * Growing prefixes of `text` (the last one is the full text) and the delay between them, so a
 * reply of any length plays in about 2-4 seconds.
 */
export function typewriterFrames(text: string): { frames: string[]; intervalMs: number } {
  const tokens = text.match(TYPEWRITER_TOKEN) ?? [];
  if (tokens.length <= 1) return { frames: [text], intervalMs: 0 };
  const count = Math.min(tokens.length, TYPEWRITER_MAX_FRAMES);
  const frames: string[] = [];
  for (let frame = 1; frame <= count; frame += 1) {
    frames.push(tokens.slice(0, Math.round((frame * tokens.length) / count)).join(''));
  }
  const duration = Math.min(TYPEWRITER_MAX_MS, Math.max(TYPEWRITER_MIN_MS, text.length * 20));
  return { frames, intervalMs: Math.round(duration / count) };
}

// ---- Local persistence ------------------------------------------------------------------------

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SavedBrainstorm {
  messages: BrainstormMessage[];
  scenario: string | null;
  turn: BrainstormTurnResult | null;
}

const STORAGE_PREFIX = 'vibebaton.guided.blueprint.v1:';
export const TYPEWRITER_STORAGE_KEY = 'vibebaton.guided.typewriter';

export function brainstormStorageKey(projectPath: string): string {
  return STORAGE_PREFIX + projectPath;
}

function browserStorage(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isMessage(value: unknown): value is BrainstormMessage {
  const item = value as BrainstormMessage | null;
  return !!item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string';
}

function isTurn(value: unknown): value is BrainstormTurnResult {
  const turn = value as BrainstormTurnResult | null;
  return !!turn && typeof turn.reply === 'string' && typeof turn.rfc_markdown === 'string'
    && !!turn.blueprint && typeof turn.blueprint === 'object'
    && !!turn.guide && Array.isArray(turn.guide.checklist) && Array.isArray(turn.guide.options);
}

/** Read the saved conversation of a project; broken or foreign data is ignored. */
export function loadBrainstorm(storage: KeyValueStore | null, projectPath: string): SavedBrainstorm | null {
  try {
    const raw = storage?.getItem(brainstormStorageKey(projectPath));
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<SavedBrainstorm>;
    if (!Array.isArray(data.messages) || !data.messages.every(isMessage) || data.messages.length === 0) return null;
    return {
      messages: data.messages,
      scenario: typeof data.scenario === 'string' ? data.scenario : null,
      turn: isTurn(data.turn) ? data.turn : null,
    };
  } catch {
    return null;
  }
}

export function saveBrainstorm(storage: KeyValueStore | null, projectPath: string, state: SavedBrainstorm): void {
  try {
    storage?.setItem(brainstormStorageKey(projectPath), JSON.stringify(state));
  } catch {
    // Storage full or blocked: the conversation simply is not kept across reloads.
  }
}

export function clearBrainstorm(storage: KeyValueStore | null, projectPath: string): void {
  try {
    storage?.removeItem(brainstormStorageKey(projectPath));
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/** The typing effect is on unless the user turned it off. */
export function loadTypewriterPref(storage: KeyValueStore | null): boolean {
  try {
    return storage?.getItem(TYPEWRITER_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveTypewriterPref(storage: KeyValueStore | null, enabled: boolean): void {
  try {
    storage?.setItem(TYPEWRITER_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Preference just is not remembered.
  }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

// ---- Component --------------------------------------------------------------------------------

let sharedClient: BatonApiClient | null = null;

function defaultApi(): GuidedBrainstormApi {
  if (!sharedClient) {
    sharedClient = new BatonApiClient();
    // Guided Studio only runs against the local server; the App normally injects its own client.
    sharedClient.mode = 'local';
  }
  return sharedClient;
}

type BrainstormLabels = (typeof MESSAGES)['en']['guided']['brainstorm'];

export interface GuidedBrainstormStepProps {
  locale: Locale;
  lineup: RecommendedLineup;
  onLaunched(runId: string): void;
  api?: GuidedBrainstormApi;
  /** Current project folder; the conversation is kept per project in localStorage. */
  projectPath?: string | null;
  /** Inject the workspace-scoped services when embedding the step. */
  services?: GuidedBrainstormServices;
  /** Share the workspace session owner with the workbench. */
  guidedSession?: GuidedSessionState;
  onBusyChange?(busy: boolean): void;
  /** The host routes a stopped parent's launch through the lineage revision API. */
  allowReplanLaunch?: boolean;
}

export type GuidedBrainstormServices = GuidedSessionApi & Pick<BatonApiClient,
  'getL0Models' | 'getModelCatalog' | 'getLineupProfiles' | 'saveLineupProfile' | 'deleteLineupProfile' | 'saveLastUsedLineup'>;

function defaultServices(): GuidedBrainstormServices {
  defaultApi();
  return sharedClient!;
}

type Catalog = Pick<ModelCatalogResponse, 'models' | 'tier_recommendations' | 'role_tiers' | 'efforts'>;
export type LaunchPayload = GuidedLaunchRunRequest & { launch_request_id: string; lineup: WorkflowLineup };

const PANEL_FAILURE_CODES = new Set([
  'synthesizer_not_configured', 'synthesizer_provider_unavailable',
  'synthesizer_credentials_missing', 'panelist_unavailable',
]);

function panelFailureCode(recommendation: WorkflowRecommendation | null): string | null {
  if (!recommendation) return null;
  return [...recommendation.explanation_codes, recommendation.reason_code]
    .find((code) => PANEL_FAILURE_CODES.has(code)) ?? null;
}

function replacementMap(current: Record<string, string>, next: Record<string, string>): Record<string, string | null> {
  return { ...Object.fromEntries(Object.keys(current).filter((key) => !(key in next)).map((key) => [key, null])), ...next };
}

function savedTurn(value: unknown): BrainstormTurnResult | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return isTurn(parsed) ? parsed : null;
  } catch { return null; }
}

function turnFromSession(session: GuidedSession): BrainstormTurnResult | null {
  const draft = session.brainstorm.latest_rfc_draft;
  if (!draft.trim()) return null;
  const readiness = checkRfcReadiness(draft);
  const lastReply = [...session.brainstorm.messages].reverse().find((message) => message.role === 'assistant');
  return {
    reply: lastReply?.content ?? '', rfc_markdown: draft,
    blueprint: { title: '', summary: '', deliverables: [], touched_areas: [], verification_plan: [],
      readiness_score: readiness.score, ready_to_launch: false },
    provider_used: null, offline: !session.brainstorm.has_online_draft, error: null,
    guide: { question: '', options: [], checklist: session.brainstorm.checklist },
  };
}

function sameWorkspace(left: string, right: string): boolean {
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');
  const a = normalize(left);
  const b = normalize(right);
  return /^[A-Za-z]:\//.test(a) && /^[A-Za-z]:\//.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function savedLaunch(value: unknown): LaunchPayload | null {
  try {
    const item: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!item || typeof item !== 'object') return null;
    const payload = item as Partial<LaunchPayload>;
    return typeof payload.launch_request_id === 'string' && !!payload.launch_request_id
      && typeof payload.rfc_markdown === 'string' && !!payload.lineup && !!payload.mode
      ? payload as LaunchPayload : null;
  } catch { return null; }
}

function replanFailure(session: GuidedSession | null): string {
  if (!session?.active_run_id) return '';
  try {
    const revision = typeof session.brainstorm.guided_revision === 'string'
      ? JSON.parse(session.brainstorm.guided_revision) : null;
    if (revision?.run_id === session.active_run_id) return '';
  } catch { /* Invalid optional revision metadata is ignored. */ }
  const contexts = session.brainstorm.replan_contexts;
  if (!contexts || typeof contexts !== 'object') return '';
  const entry = (contexts as Record<string, unknown>)[session.active_run_id];
  try {
    const value = typeof entry === 'string' ? JSON.parse(entry) : entry;
    if (!value || typeof value !== 'object') return '';
    const data = value as { run_summary?: unknown; failed_tasks?: unknown; last_errors?: unknown };
    const tasks = Array.isArray(data.failed_tasks) ? data.failed_tasks.map((task) => {
      if (!task || typeof task !== 'object') return '';
      const item = task as { id?: unknown; title?: unknown };
      return [item.id, item.title].filter((part) => typeof part === 'string').join(' — ');
    }) : [];
    const errors = data.last_errors && typeof data.last_errors === 'object'
      ? Object.entries(data.last_errors).map(([key, error]) => `${key}: ${String(error)}`) : [];
    return [typeof data.run_summary === 'string' ? data.run_summary : '', ...tasks, ...errors].filter(Boolean).join('\n');
  } catch { return ''; }
}

function hasReplanParent(session: GuidedSession | null): boolean {
  if (!session?.active_run_id) return false;
  const contexts = session.brainstorm.replan_contexts;
  return !!contexts && typeof contexts === 'object' && !!(contexts as Record<string, unknown>)[session.active_run_id];
}

export function brainstormRequestContext(
  session: GuidedSession | null, prior: string, text: string, selected: string | null, automatic: string | null,
): Pick<BrainstormChatRequest, 'requested_l0_model' | 'revision_context' | 'failure_context' | 'previous_lineup'> {
  const failure = replanFailure(session);
  return {
    requested_l0_model: selected ?? automatic,
    ...(prior ? { revision_context: { prior_rfc: prior, requested_changes: text },
      ...(failure ? { failure_context: failure } : {}) } : {}),
    ...(session?.active_run_id && Object.keys(session.workflow.lineup.roles).length
      ? { previous_lineup: session.workflow.lineup } : {}),
  };
}

/** The recommendation has already revalidated and, where needed, repaired the previous team. */
export function initialWorkflow(
  recommendation: WorkflowRecommendation,
  session: GuidedSession | null,
  fallback: RecommendedLineup,
): { lineup: RecommendedLineup; mode: WorkflowMode; previousSize: ProjectSize | null; showSwitch: boolean } {
  const previous = session?.active_run_id ? session.workflow.lineup : null;
  const chosen = recommendation.lineup;
  const lineup = chosen
    ? { ...fallback, ready: true, roles: { ...chosen.roles }, model_overrides: { ...chosen.model_overrides } }
    : { ...fallback, ready: false };
  let mode = previous && session?.workflow.mode ? session.workflow.mode : recommendation.mode;
  if (mode === 'panel' && panelFailureCode(recommendation)) mode = 'overnight';
  const previousSize = previous?.size ?? null;
  return { lineup, mode, previousSize, showSwitch: !!previousSize && recommendation.size_changed === true };
}

/** Persist the exact launch payload before dispatch, and reuse it after an uncertain result. */
export async function startKeyedLaunch(options: {
  api: Pick<GuidedBrainstormApi, 'startRun'>;
  session: GuidedSession;
  persistence: Pick<GuidedSessionState, 'save' | 'flush' | 'ensureLaunchRequestId'>;
  pending: LaunchPayload | null;
  draft: string;
  lineup: WorkflowLineup;
  mode: WorkflowMode;
  preset: string | null;
  onPrepared(payload: LaunchPayload): void;
}): Promise<string> {
  const { api, session, persistence } = options;
  let payload = options.pending;
  if (!payload) {
    if (session.active_run_id && session.workflow.guided_launch_parent !== session.active_run_id) {
      persistence.save({ workflow: { launch_request_id: null, guided_launch_parent: session.active_run_id } });
    }
    const requestId = await persistence.ensureLaunchRequestId();
    payload = { rfc_markdown: options.draft, mode: options.mode, lineup: options.lineup,
      preset: options.preset, launch_request_id: requestId };
    persistence.save({ workflow: { guided_pending_launch: JSON.stringify(payload), guided_launch_parent: session.active_run_id } });
    await persistence.flush();
    options.onPrepared(payload);
  }
  const result = await api.startRun(payload);
  return result.run_id;
}

interface Typing {
  index: number;
  frames: string[];
  intervalMs: number;
  step: number;
}

export function GuidedBrainstormStep(props: GuidedBrainstormStepProps) {
  const services = props.services ?? defaultServices();
  if (props.guidedSession) return <GuidedBrainstormBody {...props} services={services} guidedSession={props.guidedSession} />;
  return <GuidedBrainstormWithSession {...props} services={services} />;
}

function GuidedBrainstormWithSession(props: GuidedBrainstormStepProps & { services: GuidedBrainstormServices }) {
  const guidedSession = useGuidedSession(props.services);
  return <GuidedBrainstormBody {...props} guidedSession={guidedSession} />;
}

function GuidedBrainstormBody({ locale, lineup, onLaunched, api, projectPath, services, guidedSession, onBusyChange,
  allowReplanLaunch = false }:
  GuidedBrainstormStepProps & { services: GuidedBrainstormServices; guidedSession: GuidedSessionState }) {
  const labels = MESSAGES[locale].guided.brainstorm;
  const m3 = MESSAGES[locale].guided.m3;
  const zh = locale === 'zh';
  const session = guidedSession.session;
  const sessionReady = !!session && (!projectPath || !session.workspace_path || sameWorkspace(projectPath, session.workspace_path));
  const rfcId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLOListElement>(null);
  const [messages, setMessages] = useState<BrainstormMessage[]>([]);
  const [respondingModels, setRespondingModels] = useState<(string | null)[]>([]);
  const [input, setInput] = useState('');
  const [scenario, setScenario] = useState<string | null>(null);
  const [turn, setTurn] = useState<BrainstormTurnResult | null>(null);
  // While a reply is typing, the blueprint and options still show the previous turn.
  const [previousTurn, setPreviousTurn] = useState<BrainstormTurnResult | null>(null);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [typewriterOn, setTypewriterOn] = useState(() => loadTypewriterPref(browserStorage()));
  const [showRfc, setShowRfc] = useState(false);
  const [busyAction, setBusyAction] = useState<'send' | 'launch' | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [failedText, setFailedText] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [models, setModels] = useState<L0ModelsResult>({ models: [], auto_selected: null });
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelsAttempt, setModelsAttempt] = useState(0);
  const [catalog, setCatalog] = useState<Catalog>(BUILTIN_MODEL_CATALOG);
  const [profiles, setProfiles] = useState<SavedLineupProfile[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [selectedLineup, setSelectedLineup] = useState<RecommendedLineup>(lineup);
  const [mode, setMode] = useState<WorkflowMode>('overnight');
  const [preset, setPreset] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<WorkflowRecommendation | null>(null);
  const [previousSize, setPreviousSize] = useState<ProjectSize | null>(null);
  const [showSwitch, setShowSwitch] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [revisionPending, setRevisionPending] = useState(false);
  const revisionPrior = useRef('');
  const [pendingLaunch, setPendingLaunch] = useState<LaunchPayload | null>(null);
  const launchFlight = useRef(createLaunchFlight());
  const initializedSelection = useRef(false);
  const restoredSession = useRef(false);
  const busy = busyAction !== null;

  useEffect(() => {
    let active = true;
    setModelsLoading(true);
    setModelError(null);
    void services.getL0Models().then((result) => { if (active) setModels(result); })
      .catch((failure: unknown) => { if (active) setModelError(localizeGuidedError(failure, locale)); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [services, locale, modelsAttempt]);

  useEffect(() => {
    let active = true;
    void services.getModelCatalog().then((result) => { if (active) setCatalog(result); }).catch(() => {});
    void services.getLineupProfiles().then((result) => { if (active) setProfiles(result.profiles); }).catch(() => {});
    return () => { active = false; };
  }, [services]);

  // The server is authoritative; the legacy per-project copy is only a migration fallback.
  useEffect(() => {
    if (!session || restoredSession.current) return;
    if (!sessionReady) return;
    restoredSession.current = true;
    const draft = session.brainstorm;
    const snapshot = savedTurn(draft.guided_turn_snapshot);
    const legacy = projectPath ? loadBrainstorm(browserStorage(), projectPath) : null;
    const matchingSnapshot = snapshot?.rfc_markdown === draft.latest_rfc_draft ? snapshot : null;
    const matchingLegacy = legacy?.turn?.rfc_markdown === draft.latest_rfc_draft ? legacy.turn : null;
    const restored = matchingSnapshot ?? matchingLegacy ?? turnFromSession(session);
    setMessages(draft.messages);
    setTurn(restored);
    setScenario(typeof draft.guided_scenario === 'string' ? draft.guided_scenario : legacy?.scenario ?? null);
    setInput(typeof draft.guided_input === 'string' ? draft.guided_input : '');
    setModelChoice(draft.selected_l0_model);
    setRespondingModels(Array.isArray(draft.guided_responding_models)
      ? draft.guided_responding_models.map((value: unknown) => typeof value === 'string' ? value : null) : []);
    setRetryError(typeof draft.guided_retry_error === 'string' ? draft.guided_retry_error : null);
    let revision: { run_id?: string; prior_rfc?: string; requested_changes?: string } | null = null;
    try {
      const raw = draft.guided_revision;
      revision = typeof raw === 'string' ? JSON.parse(raw) : null;
    } catch { /* A malformed optional UI field is ignored. */ }
    const needsRevision = !!session.active_run_id && draft.guided_draft_parent_run_id !== session.active_run_id;
    revisionPrior.current = needsRevision && revision?.run_id === session.active_run_id && revision.prior_rfc
      ? revision.prior_rfc : needsRevision ? draft.latest_rfc_draft : '';
    setRevisionPending(needsRevision && !!revisionPrior.current.trim());
    const pending = savedLaunch(session.workflow.guided_pending_launch);
    if (pending) setPendingLaunch(pending);
    if (restored?.recommendation) {
      const previous = initialWorkflow(restored.recommendation, session, lineup);
      const inherited = allowReplanLaunch && hasReplanParent(session);
      setRecommendation(restored.recommendation);
      setPreviousSize(previous.previousSize);
      setShowSwitch(!inherited && previous.showSwitch);
      const stored = session.workflow.lineup;
      setSelectedLineup(Object.keys(stored.roles).length
        ? { ...lineup, ready: inherited || !!restored.recommendation.lineup, roles: stored.roles, model_overrides: stored.model_overrides }
        : previous.lineup);
      setMode(!inherited && panelFailureCode(restored.recommendation) && session.workflow.mode === 'panel'
        ? 'overnight' : session.workflow.mode ?? previous.mode);
      setPreset(session.workflow.preset ?? restored.recommendation.preset);
      const code = panelFailureCode(restored.recommendation);
      if (code) setPanelError(m3.recommendation.reasons[code as keyof typeof m3.recommendation.reasons]);
      initializedSelection.current = !needsRevision;
    }
  }, [session, sessionReady, projectPath, lineup, m3]);

  useEffect(() => {
    if (!typing) return undefined;
    if (typing.step >= typing.frames.length - 1) {
      setTyping(null);
      return undefined;
    }
    const timer = setTimeout(() => setTyping((current) => current && { ...current, step: current.step + 1 }), typing.intervalMs);
    return () => clearTimeout(timer);
  }, [typing]);

  useEffect(() => {
    if (busyAction !== 'send') return undefined;
    const started = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [busyAction]);

  useEffect(() => {
    const list = transcriptRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, typing?.step, pendingText]);

  const shownTurn = typing ? previousTurn : turn;
  const checklist = normalizeChecklist(shownTurn).map((item) => revisionPending ? { ...item, status: 'clear' as const } : item);
  const progress = checklistProgress(checklist);
  const assumptions = checklist.filter((item) => item.status === 'assumed');
  const card = shownTurn?.blueprint ?? null;
  const replanLaunchBlocked = hasReplanParent(session) && !allowReplanLaunch && !pendingLaunch;
  const launchable = canLaunch(card) && !!recommendation && selectedLineup.ready && !busy && !typing
    && !revisionPending && !retryError && !replanLaunchBlocked && sessionReady;
  const lastIndex = messages.length - 1;
  const question = !typing && !busy && messages[lastIndex]?.role === 'assistant' ? turn?.guide?.question ?? '' : '';
  const editPrefixes = CHECKLIST_IDS.map((id) => labels.editPrefill(labels.items[id]));
  const hint = notReadyReason(shownTurn, selectedLineup.ready, labels, zh ? '、' : ', ');

  function persist(next: SavedBrainstorm) {
    if (projectPath) saveBrainstorm(browserStorage(), projectPath, next);
  }

  function showResult(result: { messages: BrainstormMessage[]; turn: BrainstormTurnResult }) {
    const selected = selectBrainstormResult(turn, result.turn);
    const nextModels = result.messages.map((message, index) =>
      index === result.messages.length - 1 && message.role === 'assistant'
        ? result.turn.responding_model ?? null : respondingModels[index] ?? null);
    setPreviousTurn(turn);
    setMessages(result.messages);
    setRespondingModels(nextModels);
    setTurn(selected.turn);
    setRetryError(selected.retryError);
    persist({ messages: result.messages, scenario, turn: selected.turn });
    if (session) {
      // The chat endpoint already persisted the authoritative transcript and draft.
      // Only add UI metadata here, so a newer server turn cannot be overwritten.
      guidedSession.save({ brainstorm: {
        selected_l0_model: modelChoice,
        guided_turn_snapshot: JSON.stringify(selected.turn),
        guided_responding_models: nextModels,
        guided_scenario: scenario,
        guided_input: inputRef.current?.value ?? '',
        guided_retry_error: selected.retryError,
        ...(!selected.retryError ? { guided_draft_parent_run_id: session.active_run_id } : {}),
      } });
      void guidedSession.flush().catch(() => {});
    }
    if (!selected.retryError) {
      setRevisionPending(false);
      revisionPrior.current = '';
      if (result.turn.recommendation) {
        const next = result.turn.recommendation;
        setRecommendation(next);
        const code = panelFailureCode(next);
        setPanelError(code ? m3.recommendation.reasons[code as keyof typeof m3.recommendation.reasons] : null);
        if (!initializedSelection.current) {
          const initial = initialWorkflow(next, session, lineup);
          const inherited = allowReplanLaunch && hasReplanParent(session) && session
            ? { ...lineup, ready: true, roles: { ...session.workflow.lineup.roles },
              model_overrides: { ...session.workflow.lineup.model_overrides } } : null;
          setSelectedLineup(inherited ?? initial.lineup);
          setMode(inherited ? session!.workflow.mode ?? 'overnight' : initial.mode);
          const initialPreset = inherited ? session!.workflow.preset : session?.active_run_id && session.workflow.mode === initial.mode
            ? session.workflow.preset : next.preset;
          setPreset(initialPreset);
          setPreviousSize(initial.previousSize);
          setShowSwitch(!inherited && initial.showSwitch);
          initializedSelection.current = true;
          if (!inherited) saveWorkflow(initial.lineup, initial.mode, initialPreset);
        } else if (code && mode === 'panel' && !(allowReplanLaunch && hasReplanParent(session))) {
          setMode('overnight');
          saveWorkflow(selectedLineup, 'overnight', next.preset);
          setPreset(next.preset);
        }
        if (previousSize && next.size_changed === true && !(allowReplanLaunch && hasReplanParent(session))) setShowSwitch(true);
      }
    }
    if (selected.retryError) { setTyping(null); return; }
    const { frames, intervalMs } = typewriterFrames(result.turn.reply);
    setTyping(typewriterOn && !prefersReducedMotion() && frames.length > 1
      ? { index: result.messages.length - 1, frames, intervalMs, step: 0 }
      : null);
  }

  function saveWorkflow(nextLineup: RecommendedLineup, nextMode: WorkflowMode, nextPreset: string | null, size?: ProjectSize) {
    if (!session) return;
    const current = session.workflow.lineup;
    guidedSession.save({ workflow: {
      mode: nextMode, preset: nextPreset, panel_enabled: nextMode === 'panel',
      lineup: {
        roles: replacementMap(current.roles, nextLineup.roles),
        model_overrides: replacementMap(current.model_overrides, nextLineup.model_overrides ?? {}),
        ...(size ? { size } : {}),
        ...(nextLineup.customized ? { customized: true } : {}),
      },
    } });
    void guidedSession.flush().catch(() => {});
  }

  function changeLineup(next: RecommendedLineup) {
    // A hand-edited team is kept by every later recommendation.
    const custom = { ...next, customized: true };
    setSelectedLineup(custom);
    saveWorkflow(custom, mode, preset);
  }

  function changeMode(next: WorkflowMode) {
    if (next === 'panel' && panelError) return;
    setMode(next);
    const nextPreset = next === recommendation?.mode ? recommendation.preset : null;
    setPreset(nextPreset);
    saveWorkflow(selectedLineup, next, nextPreset);
  }

  function changeModel(next: string | null) {
    if (busy || pendingLaunch || !sessionReady) return;
    setModelChoice(next);
    if (session) {
      guidedSession.save({ brainstorm: { selected_l0_model: next } });
      void guidedSession.flush().catch(() => {});
    }
  }

  function requestContext(text: string): Pick<BrainstormChatRequest,
    'requested_l0_model' | 'revision_context' | 'failure_context' | 'previous_lineup'> {
    return brainstormRequestContext(session, revisionPrior.current, text, modelChoice, models.auto_selected);
  }

  async function run(mode: 'send' | 'launch', action: () => Promise<void>): Promise<boolean> {
    onBusyChange?.(true);
    setBusyAction(mode);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(localizeGuidedError(err, locale));
      return false;
    } finally {
      setBusyAction(null);
      onBusyChange?.(false);
    }
  }

  async function sendText(text: string) {
    if (!text || busy || pendingLaunch || !sessionReady || modelsLoading) return;
    setTyping(null);
    setInput('');
    setFailedText(null);
    setPendingText(text);
    const ok = await run('send', async () => {
      await guidedSession.flush();
      showResult(await sendBrainstormTurn(api ?? defaultApi(), messages, text, scenario, locale, undefined, requestContext(text)));
    });
    setPendingText(null);
    if (!ok) {
      // Keep what they wrote: back into the box (unless they started typing again) and retryable.
      setInput((current) => (current.trim() ? current : text));
      setFailedText(text);
    }
  }

  function retry() {
    if (busy || pendingLaunch || !sessionReady || modelsLoading) return;
    if (failedText) {
      void sendText(failedText);
      return;
    }
    setTyping(null);
    void run('send', async () => {
      await guidedSession.flush();
      const text = retryTranscript(messages)?.at(-1)?.content ?? '';
      showResult(await retryBrainstormTurn(api ?? defaultApi(), messages, scenario, locale, undefined, requestContext(text)));
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendText(input.trim());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSubmitOnKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) {
      event.preventDefault();
      void sendText(input.trim());
    }
  }

  function pickExample(item: BrainstormScenario) {
    const example = zh ? item.prompt_zh : item.prompt_en;
    const next = applyExample(input, example);
    // Only an example that actually lands in the box sets the scenario.
    if (next === example) {
      setScenario(item.id);
      setInput(next);
      if (sessionReady) guidedSession.save({ brainstorm: { guided_scenario: item.id, guided_input: next } });
    }
    inputRef.current?.focus();
  }

  function editItem(id: ChecklistId) {
    const next = editPrefill(input, labels.editPrefill(labels.items[id]), editPrefixes);
    setInput(next);
    if (sessionReady) guidedSession.save({ brainstorm: { guided_input: next } });
    const box = inputRef.current;
    if (box) {
      box.focus();
      requestAnimationFrame(() => box.setSelectionRange(next.length, next.length));
    }
  }

  function toggleTypewriter() {
    const next = !typewriterOn;
    setTypewriterOn(next);
    saveTypewriterPref(browserStorage(), next);
    if (!next) setTyping(null);
  }

  function restart() {
    if (busy || pendingLaunch || !sessionReady) return;
    if (projectPath) clearBrainstorm(browserStorage(), projectPath);
    setMessages([]);
    setRespondingModels([]);
    setScenario(null);
    setTurn(null);
    setPreviousTurn(null);
    setTyping(null);
    setInput('');
    setError(null);
    setFailedText(null);
    setRetryError(null);
    setRecommendation(null);
    setRevisionPending(false);
    revisionPrior.current = '';
    initializedSelection.current = false;
    if (session) {
      guidedSession.save({ brainstorm: {
        messages: [], checklist: [], latest_rfc_draft: '', has_online_draft: false,
        guided_turn_snapshot: null, guided_responding_models: [], guided_retry_error: null,
        guided_draft_parent_run_id: null, guided_scenario: null, guided_input: '',
      }, workflow: { launch_request_id: null, guided_pending_launch: null } });
      void guidedSession.flush().catch(() => {});
    }
    setShowRfc(false);
  }

  function launch() {
    if (!turn || (!launchable && !pendingLaunch) || !session || !sessionReady) return;
    void launchFlight.current(async () => {
      onBusyChange?.(true);
      setBusyAction('launch');
      setError(null);
      try {
        const chosen: WorkflowLineup = {
          roles: { ...selectedLineup.roles }, model_overrides: { ...(selectedLineup.model_overrides ?? {}) },
          ...(recommendation?.size ? { size: recommendation.size } : {}),
        };
        const runId = await startKeyedLaunch({ api: api ?? defaultApi(), session, persistence: guidedSession,
          pending: pendingLaunch, draft: turn.rfc_markdown, lineup: chosen, mode, preset, onPrepared: setPendingLaunch });
        guidedSession.save({ workflow: { guided_pending_launch: null } });
        await guidedSession.flush().catch(() => {});
        const launchedLineup = pendingLaunch?.lineup ?? chosen;
        const profile = matchSavedProfile(profiles, { ...selectedLineup, roles: launchedLineup.roles,
          model_overrides: launchedLineup.model_overrides });
        void services.saveLastUsedLineup({ roles: launchedLineup.roles, model_overrides: launchedLineup.model_overrides,
          profile_id: profile?.id ?? null, profile_name: profile?.name ?? null }).catch(() => {});
        setPendingLaunch(null);
        onLaunched(runId);
        return runId;
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === 'LAUNCH_PREFLIGHT') {
          const fallback = failure.data?.fallback;
          if (fallback) {
            setRecommendation(fallback);
            const code = panelFailureCode(fallback) ?? failure.data?.codes?.find((item) => PANEL_FAILURE_CODES.has(item));
            if (code) setPanelError(m3.recommendation.reasons[code as keyof typeof m3.recommendation.reasons] ?? failure.message);
            if (mode === 'panel' && !(allowReplanLaunch && hasReplanParent(session))) {
              setMode('overnight');
              setPreset(fallback.preset);
              saveWorkflow(selectedLineup, 'overnight', fallback.preset);
            }
          }
          setPendingLaunch(null);
          guidedSession.save({ workflow: { guided_pending_launch: null } });
          void guidedSession.flush().catch(() => {});
          setError(m3.launch.preflightFailed);
        } else {
          setError(`${localizeGuidedError(failure, locale)} ${m3.launch.uncertain}`);
        }
        throw failure;
      } finally {
        setBusyAction(null);
        onBusyChange?.(false);
      }
    }).catch(() => {});
  }

  const started = messages.length > 0 || pendingText !== null;
  const featured = BRAINSTORM_SCENARIOS.filter((item) => FEATURED_SCENARIO_IDS.includes(item.id));
  const others = BRAINSTORM_SCENARIOS.filter((item) => !FEATURED_SCENARIO_IDS.includes(item.id));
  const phase = waitingPhase(elapsedMs);
  const waitingText = phase === 'understanding'
    ? labels.waitUnderstanding
    : phase === 'drafting' ? labels.waitDrafting : labels.waitSlow;
  const exampleButton = (item: BrainstormScenario) => (
    <button
      key={item.id}
      type="button"
      className="guided-brainstorm__scenario"
      aria-pressed={scenario === item.id}
      onClick={() => pickExample(item)}
    >
      {zh ? item.title_zh : item.title_en}
    </button>
  );

  return (
    <div className="guided-brainstorm">
      <section className="guided-brainstorm__chat">
        <div className="guided-brainstorm__toolbar">
          <fieldset className="guided-brainstorm__model-controls" disabled={busy || !!pendingLaunch || !sessionReady}>
            <L0ModelSwitcher models={models.models} selected={modelChoice} autoSelected={models.auto_selected}
              loading={modelsLoading} error={modelError} catalog={catalog} onChange={changeModel} onRetry={() => setModelsAttempt((value) => value + 1)} />
          </fieldset>
          <label className="guided-brainstorm__switch">
            <input type="checkbox" checked={typewriterOn} onChange={toggleTypewriter} />
            {labels.typewriter}
          </label>
          {started ? (
            <button type="button" className="guided-brainstorm__restart" onClick={restart} disabled={busy || !!pendingLaunch}>
              {labels.restart}
            </button>
          ) : null}
        </div>
        {!started ? (
          <div className="guided-brainstorm__opening">
            <h3 className="guided-brainstorm__heading">{labels.openTitle}</h3>
            <p className="guided-brainstorm__input-hint">{labels.openHint}</p>
          </div>
        ) : null}
        {started ? (
          <ol
            ref={transcriptRef}
            className="guided-brainstorm__transcript"
            aria-live="polite"
            onClick={() => setTyping(null)}
          >
            {messages.map((message, index) => (
              <BrainstormTurn
                key={index}
                message={typing?.index === index ? { ...message, content: typing.frames[typing.step] } : message}
                modelLabel={m3.brainstorm.respondingModel}
                respondingModel={respondingModels[index] ?? m3.brainstorm.modelUnknown}
              />
            ))}
            {pendingText !== null ? <BrainstormTurn message={{ role: 'user', content: pendingText }} /> : null}
          </ol>
        ) : null}
        {question ? (
          <div className="guided-brainstorm__options" role="group" aria-label={question}>
            {(turn?.guide.options ?? []).map((option) => (
              <button key={option} type="button" className="guided-brainstorm__option" onClick={() => void sendText(option)}>
                {option}
              </button>
            ))}
            <button
              type="button"
              className="guided-brainstorm__option guided-brainstorm__option--unsure"
              onClick={() => void sendText(labels.notSure)}
            >
              {labels.notSure}
            </button>
          </div>
        ) : null}
        {busyAction === 'send' ? (
          <p className="guided-brainstorm__waiting" role="status" aria-live="polite">{waitingText}</p>
        ) : null}
        {!typing && retryError && !busy ? (
          <div className="guided-brainstorm__failure" role="alert">
            <p>{m3.brainstorm.offlineGuard} {retryError}</p>
            <button type="button" className="guided-brainstorm__retry" onClick={retry}>{m3.brainstorm.retry}</button>
          </div>
        ) : null}
        {!typing && !retryError && turn?.error && !busy ? (
          <div className="guided-brainstorm__failure" role="alert">
            <p>{labels.liveFailed(turn.error)}</p>
            <button type="button" className="guided-brainstorm__retry" onClick={retry}>{labels.retry}</button>
          </div>
        ) : null}
        {error && !busy ? (
          <div className="guided-brainstorm__failure" role="alert">
            <p>{error}</p>
            {failedText ? (
              <button type="button" className="guided-brainstorm__retry" onClick={retry}>{labels.retry}</button>
            ) : null}
          </div>
        ) : null}
        {!session && guidedSession.loading ? <p role="status">{m3.session.loading}</p> : null}
        {!session && guidedSession.error ? <p role="alert">{m3.session.loadFailed} {localizeGuidedError(guidedSession.error, locale)}</p> : null}
        {session && !sessionReady ? <p role="alert">{m3.brainstorm.stale}</p> : null}
        {session && guidedSession.error ? (
          <div className="guided-brainstorm__failure" role="alert">
            <p>{m3.session.saveFailed} {localizeGuidedError(guidedSession.error, locale)}</p>
            <button type="button" className="guided-brainstorm__retry" disabled={guidedSession.saving}
              onClick={() => { void guidedSession.flush().catch(() => {}); }}>{m3.session.retrySave}</button>
          </div>
        ) : null}
        <form className="guided-brainstorm__composer" onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="guided-brainstorm__input"
            value={input}
            placeholder={labels.inputPlaceholder}
            aria-label={started ? labels.inputPlaceholder : labels.openTitle}
            aria-describedby={hintId}
            rows={started ? 2 : 3}
            disabled={!!pendingLaunch || !sessionReady}
            onChange={(event) => {
              const value = event.target.value;
              setInput(value);
              if (sessionReady) guidedSession.save({ brainstorm: { guided_input: value } });
            }}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="guided-brainstorm__send" disabled={busy || !!pendingLaunch || !sessionReady || modelsLoading || !input.trim()}>
            {labels.send}
          </button>
        </form>
        <p id={hintId} className="guided-brainstorm__input-hint">{labels.inputHint}</p>
        {!started ? (
          <div className="guided-brainstorm__examples">
            <p className="guided-brainstorm__label">{labels.examplesTitle}</p>
            <div className="guided-brainstorm__scenarios">{featured.map(exampleButton)}</div>
            <details className="guided-brainstorm__more">
              <summary>{labels.moreExamples}</summary>
              <div className="guided-brainstorm__scenarios">{others.map(exampleButton)}</div>
            </details>
          </div>
        ) : null}
      </section>

      <aside className="guided-brainstorm__card" aria-label={labels.blueprintTitle}>
        <h3 className="guided-brainstorm__heading">{labels.blueprintTitle}</h3>
        {shownTurn?.offline && !shownTurn.error ? (
          <p className="guided-brainstorm__offline" role="note">{labels.offlineNotice}</p>
        ) : null}
        {card?.title ? <p className="guided-brainstorm__title">{card.title}</p> : null}
        {shownTurn ? (
          <p className="guided-brainstorm__progress-text">
            {labels.progress(progress.clear, progress.total)}
            {progress.assumed > 0 ? labels.progressAssumed(progress.assumed) : ''}
          </p>
        ) : (
          <p className="guided-brainstorm__empty">{labels.emptyCard}</p>
        )}
        <ul className="guided-brainstorm__checklist">
          {checklist.map((item) => (
            <li key={item.id} className={`guided-brainstorm__item guided-brainstorm__item--${item.status}`}>
              <div className="guided-brainstorm__item-head">
                <span className="guided-brainstorm__item-label">{labels.items[item.id]}</span>
                <span className="guided-brainstorm__item-status">{labels.statuses[item.status]}</span>
              </div>
              {item.value ? <p className="guided-brainstorm__item-value">{item.value}</p> : null}
              {shownTurn ? (
                <button
                  type="button"
                  className="guided-brainstorm__item-edit"
                  disabled={busy}
                  onClick={() => editItem(item.id)}
                >
                  {labels.editItem}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {shownTurn ? (
          <>
            <button
              type="button"
              className="guided-brainstorm__rfc-toggle"
              aria-expanded={showRfc}
              aria-controls={rfcId}
              onClick={() => setShowRfc((value) => !value)}
            >
              {showRfc ? labels.hideRfc : labels.showRfc}
            </button>
            {showRfc ? (
              <div id={rfcId} className="guided-brainstorm__rfc">
                <MarkdownView markdown={shownTurn.rfc_markdown} />
              </div>
            ) : null}
          </>
        ) : null}
        {assumptions.length > 0 ? (
          <div className="guided-brainstorm__assumptions" role="note">
            <p>{labels.assumptionsTitle}</p>
            <ul>
              {assumptions.map((item) => <li key={item.id}>{labels.items[item.id]}: {item.value}</li>)}
            </ul>
          </div>
        ) : null}
        {hint && !typing ? <p className="guided-brainstorm__hint">{hint}</p> : null}
        {hasReplanParent(session) && allowReplanLaunch ? (
          <p className="guided-brainstorm__hint" role="note">{m3.revision.inheritedWorkflow}</p>
        ) : null}
        {canLaunch(card) && recommendation && !revisionPending && replanLaunchBlocked ? (
          <p className="guided-brainstorm__hint" role="note">{zh
            ? '当前启动接口无法连接已停止的上一轮，修订蓝图已保留，暂不能安全启动。'
            : 'The start endpoint cannot attach the stopped run. The revised blueprint is saved until it can be started safely.'}</p>
        ) : null}
        {canLaunch(card) && recommendation && !revisionPending ? (
          <GuidedLaunchBar recommendation={recommendation} lineup={selectedLineup} mode={mode}
            previousSize={previousSize} showSwitch={showSwitch} panelFailure={panelError}
            providers={[...new Set(models.models.map((model) => model.provider))]} catalog={catalog} profiles={profiles}
            pending={busyAction === 'launch'} disabled={!launchable && !pendingLaunch}
            locked={!!pendingLaunch || (allowReplanLaunch && hasReplanParent(session))}
            profileError={profileError} onLineupChange={changeLineup} onModeChange={changeMode}
            onSwitch={() => {
              setMode(recommendation.mode);
              saveWorkflow(selectedLineup, recommendation.mode, recommendation.preset, recommendation.size ?? undefined);
              setPreset(recommendation.preset);
              setShowSwitch(false);
            }}
            onDismissSwitch={() => setShowSwitch(false)}
            onSaveProfile={async (name) => {
              setProfileError(null);
              try {
                const result = await services.saveLineupProfile({ name, roles: selectedLineup.roles,
                  model_overrides: selectedLineup.model_overrides ?? {} });
                setProfiles(result.profiles);
              } catch (failure) {
                setProfileError(localizeGuidedError(failure, locale));
                throw failure;
              }
            }} onDeleteProfile={async (profileId) => {
              setProfileError(null);
              try {
                const result = await services.deleteLineupProfile(profileId);
                setProfiles(result.profiles);
              } catch (failure) {
                setProfileError(localizeGuidedError(failure, locale));
                throw failure;
              }
            }} onLaunch={launch} />
        ) : null}
      </aside>
    </div>
  );
}
