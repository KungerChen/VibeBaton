import './GuidedBrainstormStep.css';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  BatonApiClient,
  type BlueprintCard,
  type BlueprintConfirmResult,
  type BrainstormChatRequest,
  type BrainstormMessage,
  type BrainstormTurnResult,
  type ChecklistId,
  type ChecklistItem,
  type RecommendedLineup,
} from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import type { LaunchRunRequest } from '../../types/graph';
import { localizeGuidedError } from './guidedErrors';
import scenarioList from './brainstormScenarios.json';
import { MarkdownView } from '../ui/MarkdownView';

/** The three backend calls this step needs; inject a fake in tests or the App's shared client. */
export interface GuidedBrainstormApi {
  brainstormChat(payload: BrainstormChatRequest): Promise<BrainstormTurnResult>;
  brainstormConfirm(rfcMarkdown: string): Promise<BlueprintConfirmResult>;
  startRun(payload: LaunchRunRequest): Promise<{ run_id: string }>;
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
export function BrainstormTurn({ message }: { message: BrainstormMessage }) {
  return (
    <li className={`guided-brainstorm__turn guided-brainstorm__turn--${message.role}`}>
      {message.role === 'assistant' ? <MarkdownView markdown={message.content} /> : message.content}
    </li>
  );
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
): Promise<{ messages: BrainstormMessage[]; turn: BrainstormTurnResult }> {
  const payload: BrainstormChatRequest = locale ? { messages: withUser, scenario, locale } : { messages: withUser, scenario };
  // Run the brainstorm on the L0 model picked in Workspace: its explicit spec, else just its provider.
  const l0Spec = lineup?.model_overrides?.[L0_ROLE];
  const l0Provider = lineup?.roles[L0_ROLE];
  if (l0Spec) payload.model_overrides = { [L0_ROLE]: l0Spec };
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
): Promise<{ messages: BrainstormMessage[]; turn: BrainstormTurnResult }> {
  return chat(api, appendTurn(messages, 'user', input), scenario, locale, lineup);
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
): Promise<{ messages: BrainstormMessage[]; turn: BrainstormTurnResult }> {
  const transcript = retryTranscript(messages);
  if (!transcript) throw new Error('Nothing to retry.');
  return chat(api, transcript, scenario, locale, lineup);
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
}

interface Typing {
  index: number;
  frames: string[];
  intervalMs: number;
  step: number;
}

export function GuidedBrainstormStep({ locale, lineup, onLaunched, api, projectPath }: GuidedBrainstormStepProps) {
  const labels = MESSAGES[locale].guided.brainstorm;
  const zh = locale === 'zh';
  const rfcId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLOListElement>(null);
  const [messages, setMessages] = useState<BrainstormMessage[]>([]);
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
  const busy = busyAction !== null;

  // Restore the saved conversation of this project (no replay of the typing effect).
  const loadedPath = useRef<string | null>(null);
  useEffect(() => {
    if (!projectPath) return;
    const firstPath = loadedPath.current === null;
    loadedPath.current = projectPath;
    const saved = loadBrainstorm(browserStorage(), projectPath);
    // Nothing saved: keep what is on screen, unless this is a different project than before.
    if (!saved && firstPath) return;
    setMessages(saved?.messages ?? []);
    setScenario(saved?.scenario ?? null);
    setTurn(saved?.turn ?? null);
    setTyping(null);
  }, [projectPath]);

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
  const checklist = normalizeChecklist(shownTurn);
  const progress = checklistProgress(checklist);
  const assumptions = checklist.filter((item) => item.status === 'assumed');
  const card = shownTurn?.blueprint ?? null;
  const launchable = canLaunch(card) && lineup.ready && !busy && !typing;
  const lastIndex = messages.length - 1;
  const question = !typing && !busy && messages[lastIndex]?.role === 'assistant' ? turn?.guide?.question ?? '' : '';
  const editPrefixes = CHECKLIST_IDS.map((id) => labels.editPrefill(labels.items[id]));
  const hint = notReadyReason(shownTurn, lineup.ready, labels, zh ? '、' : ', ');

  function persist(next: SavedBrainstorm) {
    if (projectPath) saveBrainstorm(browserStorage(), projectPath, next);
  }

  function showResult(result: { messages: BrainstormMessage[]; turn: BrainstormTurnResult }) {
    setPreviousTurn(turn);
    setMessages(result.messages);
    setTurn(result.turn);
    persist({ messages: result.messages, scenario, turn: result.turn });
    const { frames, intervalMs } = typewriterFrames(result.turn.reply);
    setTyping(typewriterOn && !prefersReducedMotion() && frames.length > 1
      ? { index: result.messages.length - 1, frames, intervalMs, step: 0 }
      : null);
  }

  async function run(mode: 'send' | 'launch', action: () => Promise<void>): Promise<boolean> {
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
    }
  }

  async function sendText(text: string) {
    if (!text || busy) return;
    setTyping(null);
    setInput('');
    setFailedText(null);
    setPendingText(text);
    const ok = await run('send', async () => {
      showResult(await sendBrainstormTurn(api ?? defaultApi(), messages, text, scenario, locale, lineup));
    });
    setPendingText(null);
    if (!ok) {
      // Keep what they wrote: back into the box (unless they started typing again) and retryable.
      setInput((current) => (current.trim() ? current : text));
      setFailedText(text);
    }
  }

  function retry() {
    if (busy) return;
    if (failedText) {
      void sendText(failedText);
      return;
    }
    setTyping(null);
    void run('send', async () => {
      showResult(await retryBrainstormTurn(api ?? defaultApi(), messages, scenario, locale, lineup));
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
    }
    inputRef.current?.focus();
  }

  function editItem(id: ChecklistId) {
    const next = editPrefill(input, labels.editPrefill(labels.items[id]), editPrefixes);
    setInput(next);
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
    if (busy) return;
    if (projectPath) clearBrainstorm(browserStorage(), projectPath);
    setMessages([]);
    setScenario(null);
    setTurn(null);
    setPreviousTurn(null);
    setTyping(null);
    setInput('');
    setError(null);
    setFailedText(null);
    setShowRfc(false);
  }

  function launch() {
    if (!turn || !launchable) return;
    void run('launch', async () => onLaunched(await confirmAndStart(api ?? defaultApi(), turn.rfc_markdown, lineup)));
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
          <label className="guided-brainstorm__switch">
            <input type="checkbox" checked={typewriterOn} onChange={toggleTypewriter} />
            {labels.typewriter}
          </label>
          {started ? (
            <button type="button" className="guided-brainstorm__restart" onClick={restart} disabled={busy}>
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
        {!typing && turn?.error && !busy ? (
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
        <form className="guided-brainstorm__composer" onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="guided-brainstorm__input"
            value={input}
            placeholder={labels.inputPlaceholder}
            aria-label={started ? labels.inputPlaceholder : labels.openTitle}
            aria-describedby={hintId}
            rows={started ? 2 : 3}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="guided-brainstorm__send" disabled={busy || !input.trim()}>
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
        <button type="button" className="guided-brainstorm__launch" disabled={!launchable} onClick={launch}>
          {busyAction === 'launch' ? labels.launching : labels.confirmLaunch}
        </button>
      </aside>
    </div>
  );
}
