import './BottomDock.css';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, type GateReceipt, type RunArtifactResponse } from '../../api/client';
import { formatDurationSec } from '../../engine/liveClock';
import { formatLiveEventMessage, translateEventKind } from '../../i18n/liveEvents';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatProviderModel, translateRole } from '../../i18n/presets';
import { LIVE_EVENT_LIMIT, type RunSyncStatus } from '../../state/runStore';
import type { LiveRunSnapshot } from '../../types/graph';
import { browserStorage } from './ContextDrawer';
import { localizeGuidedError } from './guidedErrors';

export type DockTab = 'timeline' | 'terminal' | 'gates';
const DOCK_TABS: readonly DockTab[] = ['timeline', 'terminal', 'gates'];
export const DOCK_OPEN_KEY = 'vibebaton.dock.open';
export const DOCK_TAB_KEY = 'vibebaton.dock.tab';

/** What the user last chose; collapsed on the Timeline when nothing is stored. */
function readDock(): { open: boolean; tab: DockTab } {
  try {
    const storage = browserStorage();
    const tab = storage?.getItem(DOCK_TAB_KEY);
    return { open: storage?.getItem(DOCK_OPEN_KEY) === 'open', tab: DOCK_TABS.find((item) => item === tab) ?? 'timeline' };
  } catch {
    return { open: false, tab: 'timeline' };
  }
}

function remember(key: string, value: string) {
  try { browserStorage()?.setItem(key, value); } catch { /* Storage may be unavailable. */ }
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function payloadOf(event: Record<string, unknown>): Record<string, unknown> | null {
  let payload = event.payload ?? event.payload_json;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
}

export interface ModelCall {
  eventId: number;
  /** Names the saved prompt and output; null when the call recorded none. */
  artifactKey: string | null;
  role: string;
  model: string;
  /** The task or milestone of the call. */
  scopeId: string | null;
  at: number | null;
}

/** Each model call (`role_invoked`) among the snapshot's events, newest first. */
export function modelCalls(events: readonly Record<string, unknown>[]): ModelCall[] {
  return events.flatMap((event): ModelCall[] => {
    if (event.kind !== 'role_invoked' || typeof event.id !== 'number') return [];
    const actor = text(event.actor);
    const colon = actor.indexOf(':');
    const key = payloadOf(event)?.artifact_key;
    return [{
      eventId: event.id,
      artifactKey: typeof key === 'string' && key ? key : null,
      role: colon >= 0 ? actor.slice(0, colon) : actor,
      model: colon >= 0 ? actor.slice(colon + 1) : '',
      scopeId: text(event.task_id) || text(event.milestone_id) || null,
      at: typeof event.created_at === 'number' ? event.created_at : null,
    }];
  }).reverse();
}

function clock(at: unknown, locale: Locale): string {
  return typeof at === 'number' && Number.isFinite(at)
    ? new Date(at * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

type ArtifactState =
  | { phase: 'loading' }
  | { phase: 'ready'; response: RunArtifactResponse }
  | { phase: 'missing' }
  | { phase: 'error'; message: string };

export interface BottomDockProps {
  runId: string;
  snapshot: LiveRunSnapshot;
  /** Every gate receipt of the run, oldest first; null until read. */
  receipts: readonly GateReceipt[] | null;
  receiptsFailed?: boolean;
  locale: Locale;
  syncStatus?: RunSyncStatus;
  reconnecting?: boolean;
  loadArtifact(artifactKey: string): Promise<RunArtifactResponse>;
}

/**
 * The dock under Build and Sign-Off: one line with the latest event, or the Timeline, Terminal and Gates
 * tabs. Only the user's own expand and tab choice are remembered.
 */
export function BottomDock({
  runId, snapshot, receipts, receiptsFailed = false, locale, syncStatus, reconnecting, loadArtifact,
}: BottomDockProps) {
  const messages = MESSAGES[locale];
  const copy = messages.guided.dock;
  const relay = messages.guided.relay;
  const id = useId();
  const [{ open, tab }, setDock] = useState(readDock);
  const [shownCall, setShownCall] = useState<number | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactState>>({});
  const timeline = useRef<HTMLOListElement>(null);
  const events = snapshot.events;
  const latest = events.at(-1);
  const calls = modelCalls(events);

  // Keep the newest event in view while the timeline is open.
  useEffect(() => {
    if (open && tab === 'timeline' && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [open, tab, events]);

  function toggle() {
    setDock({ open: !open, tab });
    remember(DOCK_OPEN_KEY, open ? 'closed' : 'open');
  }

  function choose(next: DockTab) {
    setDock({ open, tab: next });
    remember(DOCK_TAB_KEY, next);
  }

  function describe(event: Record<string, unknown>) {
    const kind = text(event.kind) || 'event';
    return {
      time: clock(event.created_at, locale),
      kind: translateEventKind(kind, locale),
      taskId: text(event.task_id),
      ...formatLiveEventMessage(kind, text(event.message), locale, event.payload ?? event.payload_json),
    };
  }

  function openCall(call: ModelCall) {
    setShownCall(call.eventId);
    const key = call.artifactKey;
    if (!key || (artifacts[key] && artifacts[key].phase !== 'error')) return;
    setArtifacts((all) => ({ ...all, [key]: { phase: 'loading' } }));
    loadArtifact(key).then(
      (response) => setArtifacts((all) => ({ ...all, [key]: { phase: 'ready', response } })),
      (failure: unknown) => setArtifacts((all) => ({ ...all, [key]: failure instanceof ApiError && failure.status === 404
        ? { phase: 'missing' } : { phase: 'error', message: localizeGuidedError(failure, locale) } })),
    );
  }

  function artifactView() {
    const call = calls.find((item) => item.eventId === shownCall);
    if (!call) return null;
    const state = call.artifactKey ? artifacts[call.artifactKey] : { phase: 'missing' as const };
    if (!state || state.phase === 'loading') return <p className="bottom-dock__muted">{relay.handoff.loading}</p>;
    if (state.phase === 'error') return <p className="bottom-dock__error" role="alert">{state.message}</p>;
    if (state.phase === 'missing') return <p className="bottom-dock__muted">{relay.notRecorded}</p>;
    return (['output', 'prompt'] as const).map((part) => {
      const value = state.response[part];
      return (
        <section key={part} className="bottom-dock__part">
          <h4>{part === 'output' ? copy.output : copy.prompt}</h4>
          {value ? (
            <>
              {value.truncated ? <p className="bottom-dock__muted">{relay.handoff.truncated}</p> : null}
              <pre className="bottom-dock__text">{value.text}</pre>
            </>
          ) : <p className="bottom-dock__muted">{relay.notRecorded}</p>}
        </section>
      );
    });
  }

  function timelinePanel() {
    return (
      <>
        <p className="bottom-dock__note">{copy.timelineLimit(LIVE_EVENT_LIMIT)}</p>
        {events.length ? (
          <ol ref={timeline} className="bottom-dock__scroll bottom-dock__timeline" aria-label={messages.inspector.eventLogAria}>
            {events.map((event, index) => {
              const item = describe(event);
              return (
                <li key={text(event.id) || `event-${index}`} data-event-id={text(event.id)} className="bottom-dock__event">
                  {item.time ? <time className="bottom-dock__time">{item.time}</time> : null}
                  <strong className="bottom-dock__kind">{item.kind}</strong>
                  {item.taskId ? <code>{item.taskId}</code> : null}
                  <span>{item.summary}</span>
                  {item.rawDetail ? (
                    <details className="bottom-dock__raw">
                      <summary>{messages.inspector.originalNote}</summary>
                      <pre className="bottom-dock__text">{item.rawDetail}</pre>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : <p className="bottom-dock__muted">{copy.noEvents}</p>}
      </>
    );
  }

  function terminalPanel() {
    return (
      <>
        <p className="bottom-dock__note">{copy.terminalNote(LIVE_EVENT_LIMIT)}</p>
        {calls.length ? (
          <div className="bottom-dock__terminal">
            <ul className="bottom-dock__scroll bottom-dock__calls">
              {calls.map((call) => (
                <li key={call.eventId}>
                  <button type="button" className="bottom-dock__call" data-call={call.eventId}
                    aria-pressed={shownCall === call.eventId} onClick={() => openCall(call)}>
                    {call.at !== null ? <time className="bottom-dock__time">{clock(call.at, locale)}</time> : null}
                    <strong>{translateRole(call.role, locale)}</strong>
                    <code>{formatProviderModel(null, call.model) || relay.unknown}</code>
                    {call.scopeId ? <code>{call.scopeId}</code> : null}
                  </button>
                </li>
              ))}
            </ul>
            <div className="bottom-dock__scroll bottom-dock__artifact" data-field="artifact">{artifactView()}</div>
          </div>
        ) : <p className="bottom-dock__muted">{copy.noCalls}</p>}
      </>
    );
  }

  function gatesPanel() {
    return (
      <>
        <p className="bottom-dock__note">{copy.gatesNote}</p>
        {receipts && receipts.length ? (
          <ul className="bottom-dock__scroll bottom-dock__receipts">
            {[...receipts].reverse().map((receipt) => {
              const passed = receipt.exit_code === 0;
              return (
                <li data-field="receipt" data-passed={passed} key={receipt.event_id} className="bottom-dock__receipt">
                  <p>
                    <strong className={passed ? 'bottom-dock__pass' : 'bottom-dock__fail'}>
                      {passed ? relay.handoff.receiptPassed : relay.handoff.receiptFailed}
                    </strong>
                    {` · ${relay.handoff.scopes[receipt.scope]} `}<code>{receipt.target_id}</code>
                    {` · ${relay.handoff.exitCode(receipt.exit_code)} · ${formatDurationSec(receipt.duration_sec, locale)}`}
                  </p>
                  <code className="bottom-dock__command">{receipt.command}</code>
                  {receipt.output_tail ? (
                    <details>
                      <summary>{relay.handoff.outputTail}</summary>
                      <pre className="bottom-dock__text">{receipt.output_tail}</pre>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : receiptsFailed ? <p className="bottom-dock__muted">{copy.gatesFailed}</p>
          : receipts === null ? <p className="bottom-dock__muted">{relay.handoff.loading}</p>
            : <p className="bottom-dock__muted" data-field="receipts">{relay.handoff.noReceipts}</p>}
      </>
    );
  }

  const latestItem = latest ? describe(latest) : null;
  return (
    <section className="bottom-dock" data-dock-open={open} data-run={runId} aria-label={copy.aria}>
      <div className="bottom-dock__bar">
        <p className="bottom-dock__latest" data-field="latest"
          title={latestItem ? [latestItem.time, latestItem.kind, latestItem.taskId, latestItem.summary].filter(Boolean).join(' · ') : undefined}>
          {latestItem ? (
            <>
              {latestItem.time ? <time className="bottom-dock__time">{latestItem.time}</time> : null}
              <strong className="bottom-dock__kind">{latestItem.kind}</strong>
              {latestItem.taskId ? <code>{latestItem.taskId}</code> : null}
              <span className="bottom-dock__summary">{latestItem.summary}</span>
            </>
          ) : <span className="bottom-dock__muted">{copy.noEvents}</span>}
        </p>
        <span className="bottom-dock__status">
          {reconnecting ? <span className="bottom-dock__badge bottom-dock__badge--warn" role="status">{messages.inspector.reconnecting}</span> : null}
          {syncStatus === 'loading' ? <span className="bottom-dock__badge" role="status">{messages.inspector.runSyncing}</span> : null}
          {syncStatus === 'error' ? (
            <span className="bottom-dock__badge bottom-dock__badge--error" role="status" title={messages.inspector.runSyncFailed}>
              {messages.inspector.runSyncFailed}
            </span>
          ) : null}
        </span>
        <button type="button" className="bottom-dock__toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
          {open ? copy.collapse : copy.expand}
        </button>
      </div>
      {open ? (
        <div id={`${id}-body`} className="bottom-dock__body">
          <div className="bottom-dock__tabs" role="tablist" aria-label={copy.tabsAria}>
            {DOCK_TABS.map((item) => (
              <button key={item} type="button" role="tab" id={`${id}-tab-${item}`} aria-selected={item === tab}
                aria-controls={`${id}-panel`} data-tab={item} className="bottom-dock__tab" onClick={() => choose(item)}>
                {copy.tabs[item]}
              </button>
            ))}
          </div>
          <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} data-tab={tab} className="bottom-dock__panel">
            {tab === 'timeline' ? timelinePanel() : tab === 'terminal' ? terminalPanel() : gatesPanel()}
          </div>
        </div>
      ) : null}
    </section>
  );
}
