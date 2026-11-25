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

/** The three backend calls this step needs; inject a fake in tests or the App's shared client. */
export interface GuidedBrainstormApi {
  brainstormChat(payload: BrainstormChatRequest): Promise<BrainstormTurnResult>;
  brainstormConfirm(rfcMarkdown: string): Promise<BlueprintConfirmResult>;
  startRun(payload: LaunchRunRequest): Promise<{ run_id: string }>;
}

/** Mirror of backend `brainstorm.SCENARIOS` (src/vibebaton/brainstorm.py); ids must stay in sync. */
export const BRAINSTORM_SCENARIOS = [
  {
    id: 'new_feature',
    title_en: 'Ship a new feature',
    title_zh: '交付一个新功能',
    prompt_en: 'I want to add a new feature. Here is what it should do for the people using it:',
    prompt_zh: '我想增加一个新功能，它应该为使用者带来这些能力：',
  },
  {
    id: 'bug_fix',
    title_en: 'Fix a bug for good',
    title_zh: '彻底修复一个缺陷',
    prompt_en: 'Something is broken. Here is what I expected, what actually happens, and how to reproduce it:',
    prompt_zh: '有个功能出了问题。我期望的结果、实际发生的情况以及复现步骤如下：',
  },
  {
    id: 'refactor',
    title_en: 'Refactor safely',
    title_zh: '安全地重构',
    prompt_en: 'I want to restructure this part of the codebase without changing its behavior:',
    prompt_zh: '我想在不改变行为的前提下重新整理这部分代码：',
  },
  {
    id: 'add_tests',
    title_en: 'Strengthen test coverage',
    title_zh: '加强测试覆盖',
    prompt_en: 'I want automated tests that protect these critical behaviors:',
    prompt_zh: '我希望用自动化测试守护这些关键行为：',
  },
  {
    id: 'web_app',
    title_en: 'Start a small web app',
    title_zh: '从零搭建一个小型网页应用',
    prompt_en: 'I want to build a small web app. Its main pages and what each one does:',
    prompt_zh: '我想做一个小型网页应用，主要页面和各自的作用如下：',
  },
] as const;

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
): Promise<{ messages: BrainstormMessage[]; turn: BrainstormTurnResult }> {
  const withUser = appendTurn(messages, 'user', input);
  const turn = await api.brainstormChat(locale ? { messages: withUser, scenario, locale } : { messages: withUser, scenario });
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
  const { run_id } = await api.startRun({ rfc_path, mode: 'overnight', role_providers: { ...lineup.roles } });
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
  const [messages, setMessages] = useState<BrainstormMessage[]>([]);
  const [input, setInput] = useState('');
  const [scenario, setScenario] = useState<string | null>(null);
  const [turn, setTurn] = useState<BrainstormTurnResult | null>(null);
  const [showRfc, setShowRfc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const card = turn?.blueprint ?? null;
  const launchable = canLaunch(card) && lineup.ready && !busy;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(localizeGuidedError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void run(async () => {
      const result = await sendBrainstormTurn(api ?? defaultApi(), messages, text, scenario, locale);
      setMessages(result.messages);
      setTurn(result.turn);
      setInput('');
    });
  }

  function launch() {
    if (!turn || !launchable) return;
    void run(async () => onLaunched(await confirmAndStart(api ?? defaultApi(), turn.rfc_markdown, lineup)));
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
            <li key={index} className={`guided-brainstorm__turn guided-brainstorm__turn--${message.role}`}>
              {message.content}
            </li>
          ))}
        </ol>
        <form className="guided-brainstorm__composer" onSubmit={send}>
          <textarea
            className="guided-brainstorm__input"
            value={input}
            placeholder={labels.inputPlaceholder}
            aria-label={labels.inputPlaceholder}
            rows={3}
            onChange={(event) => setInput(event.target.value)}
          />
          <button type="submit" className="guided-brainstorm__send" disabled={busy || !input.trim()}>
            {labels.send}
          </button>
        </form>
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
            {showRfc ? <pre id={rfcId} className="guided-brainstorm__rfc">{turn.rfc_markdown}</pre> : null}
          </>
        ) : null}
        <button type="button" className="guided-brainstorm__launch" disabled={!launchable} onClick={launch}>
          {labels.confirmLaunch}
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
