import './GuidedBrainstormStep.css';
import { useId, useState, type FormEvent } from 'react';
import {
  BatonApiClient,
  type BlueprintCard,
  type BlueprintConfirmResult,
  type BrainstormChatRequest,
  type BrainstormMessage,
  type BrainstormTurnResult,
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

/** The Guided page's L0 role; its lineup choice also drives the brainstorm. */
const L0_ROLE = 'brainstorm_and_final_gate';

export type ReadinessTone = 'low' | 'medium' | 'high';

/** Return a new transcript with one turn appended; the input array is never mutated. */
export function appendTurn(
  messages: readonly BrainstormMessage[],
  role: BrainstormMessage['role'],
  content: string,
): BrainstormMessage[] {
  return [...messages, { role, content }];
}

/** Colour band for the readiness meter: <50 low, <80 medium, otherwise high. */
export function readinessTone(score: number): ReadinessTone {
  if (score < 50) return 'low';
  if (score < 80) return 'medium';
  return 'high';
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

/** One chat round-trip: append the user turn, ask the architect, append its reply. */
export async function sendBrainstormTurn(
  api: Pick<GuidedBrainstormApi, 'brainstormChat'>,
  messages: readonly BrainstormMessage[],
  input: string,
  scenario: string | null,
  locale?: Locale,
  lineup?: Pick<RecommendedLineup, 'roles' | 'model_overrides'>,
): Promise<{ messages: BrainstormMessage[]; turn: BrainstormTurnResult }> {
  const withUser = appendTurn(messages, 'user', input);
  const payload: BrainstormChatRequest = locale ? { messages: withUser, scenario, locale } : { messages: withUser, scenario };
  // Run the brainstorm on the L0 model picked in Workspace: its explicit spec, else just its provider.
  const l0Spec = lineup?.model_overrides?.[L0_ROLE];
  const l0Provider = lineup?.roles[L0_ROLE];
  if (l0Spec) payload.model_overrides = { [L0_ROLE]: l0Spec };
  else if (l0Provider) payload.role_providers = { [L0_ROLE]: l0Provider };
  const turn = await api.brainstormChat(payload);
  return { messages: appendTurn(withUser, 'assistant', turn.reply), turn };
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

let sharedClient: BatonApiClient | null = null;

function defaultApi(): GuidedBrainstormApi {
  if (!sharedClient) {
    sharedClient = new BatonApiClient();
    // Guided Studio only runs against the local server; the App normally injects its own client.
    sharedClient.mode = 'local';
  }
  return sharedClient;
}

export interface GuidedBrainstormStepProps {
  locale: Locale;
  lineup: RecommendedLineup;
  onLaunched(runId: string): void;
  api?: GuidedBrainstormApi;
}

export function GuidedBrainstormStep({ locale, lineup, onLaunched, api }: GuidedBrainstormStepProps) {
  const labels = MESSAGES[locale].guided.brainstorm;
  const zh = locale === 'zh';
  const rfcId = useId();
  const hintId = useId();
  const [messages, setMessages] = useState<BrainstormMessage[]>([]);
  const [input, setInput] = useState('');
  const [scenario, setScenario] = useState<string | null>(null);
  const [turn, setTurn] = useState<BrainstormTurnResult | null>(null);
  const [showRfc, setShowRfc] = useState(false);
  const [busyAction, setBusyAction] = useState<'send' | 'launch' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = busyAction !== null;

  const card = turn?.blueprint ?? null;
  const launchable = canLaunch(card) && lineup.ready && !busy;

  async function run(mode: 'send' | 'launch', action: () => Promise<void>) {
    setBusyAction(mode);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(localizeGuidedError(err, locale));
    } finally {
      setBusyAction(null);
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void run('send', async () => {
      const result = await sendBrainstormTurn(api ?? defaultApi(), messages, text, scenario, locale, lineup);
      setMessages(result.messages);
      setTurn(result.turn);
      setInput('');
    });
  }

  function launch() {
    if (!turn || !launchable) return;
    void run('launch', async () => onLaunched(await confirmAndStart(api ?? defaultApi(), turn.rfc_markdown, lineup)));
  }

  return (
    <div className="guided-brainstorm">
      <section className="guided-brainstorm__chat">
        <h3 className="guided-brainstorm__heading">{labels.scenariosTitle}</h3>
        <div className="guided-brainstorm__scenarios">
          {BRAINSTORM_SCENARIOS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="guided-brainstorm__scenario"
              aria-pressed={scenario === item.id}
              onClick={() => {
                setScenario(item.id);
                setInput(zh ? item.prompt_zh : item.prompt_en);
              }}
            >
              {zh ? item.title_zh : item.title_en}
            </button>
          ))}
        </div>
        <ol className="guided-brainstorm__transcript" aria-live="polite">
          {messages.map((message, index) => (
            <BrainstormTurn key={index} message={message} />
          ))}
        </ol>
        <p id={hintId} className="guided-brainstorm__input-hint">{labels.inputHint}</p>
        <form className="guided-brainstorm__composer" onSubmit={send}>
          <textarea
            className="guided-brainstorm__input"
            value={input}
            placeholder={labels.inputPlaceholder}
            aria-label={labels.inputPlaceholder}
            aria-describedby={hintId}
            rows={6}
            onChange={(event) => setInput(event.target.value)}
          />
          <button type="submit" className="guided-brainstorm__send" disabled={busy || !input.trim()}>
            {busyAction === 'send' ? labels.sending : labels.send}
          </button>
        </form>
        {busy ? (
          <div className="guided-brainstorm__progress" role="status" aria-live="polite">
            <div className="guided-brainstorm__progress-bar" />
          </div>
        ) : null}
        {error ? <p className="guided-brainstorm__error" role="alert">{error}</p> : null}
      </section>

      <aside className="guided-brainstorm__card" aria-label={labels.blueprintTitle}>
        <h3 className="guided-brainstorm__heading">{labels.blueprintTitle}</h3>
        {turn?.offline ? (
          <p className="guided-brainstorm__offline" role="note">{labels.offlineNotice}</p>
        ) : null}
        {card ? (
          <>
            <p className="guided-brainstorm__title">{card.title}</p>
            <h4 className="guided-brainstorm__label">{labels.summary}</h4>
            <p className="guided-brainstorm__text">{card.summary}</p>
            <BlueprintList label={labels.deliverables} items={card.deliverables} />
            <BlueprintList label={labels.touchedAreas} items={card.touched_areas} />
            <BlueprintList label={labels.verificationPlan} items={card.verification_plan} />
          </>
        ) : (
          <p className="guided-brainstorm__empty">{labels.emptyCard}</p>
        )}
        <h4 className="guided-brainstorm__label">{labels.readiness}</h4>
        <meter
          className={`guided-brainstorm__meter guided-brainstorm__meter--${readinessTone(card?.readiness_score ?? 0)}`}
          min={0}
          max={100}
          low={50}
          high={80}
          optimum={100}
          value={card?.readiness_score ?? 0}
          aria-label={labels.readiness}
        />
        <span className="guided-brainstorm__score">{card?.readiness_score ?? 0}/100</span>
        {card && !canLaunch(card) ? (
          <p className="guided-brainstorm__hint">{labels.notReadyHint}</p>
        ) : null}
        {turn ? (
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
                <MarkdownView markdown={turn.rfc_markdown} />
              </div>
            ) : null}
          </>
        ) : null}
        <button type="button" className="guided-brainstorm__launch" disabled={!launchable} onClick={launch}>
          {busyAction === 'launch' ? labels.launching : labels.confirmLaunch}
        </button>
      </aside>
    </div>
  );
}

function BlueprintList({ label, items }: { label: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h4 className="guided-brainstorm__label">{label}</h4>
      <ul className="guided-brainstorm__list">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </>
  );
}
