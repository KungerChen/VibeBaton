import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { LiveRunSnapshot } from '../../types/graph';
import type { RightInspectorProps } from '../types';
import { Modal } from '../ui/Modal';
import { StartRunModal } from './StartRunModal';

const eventLimit = 200;
const emptySnapshot: LiveRunSnapshot = { run: null, milestones: [], tasks: [], events: [], quotas: [] };
const statusStyles = new Map([
  ['RUNNING', 'right-inspector__status--running'],
  ['PAUSED', 'right-inspector__status--paused'],
  ['WAITING_HUMAN', 'pill--warn'],
  ['COMPLETED', 'pill--ok'],
  ['FAILED', 'pill--err'],
  ['HALTED', 'pill--err'],
]);

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRows(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRow);
}

function isSnapshot(value: unknown): value is LiveRunSnapshot {
  return isRow(value) && (value.run === null || isRow(value.run))
    && isRows(value.milestones) && isRows(value.tasks) && isRows(value.events) && isRows(value.quotas);
}

function withRecentEvents(snapshot: LiveRunSnapshot): LiveRunSnapshot {
  return { ...snapshot, events: snapshot.events.slice(-eventLimit) };
}

function display(value: unknown, fallback = '—'): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

type LiveRunPanelProps = Pick<RightInspectorProps, 'client' | 'onToast'> & { visible: boolean };
type RunAction = 'pause' | 'resume' | 'approve' | 'reject';

export function LiveRunPanel({ client, onToast, visible }: LiveRunPanelProps) {
  const { messages } = useI18n();
  const [snapshot, setSnapshot] = useState<LiveRunSnapshot>(emptySnapshot);
  const [reconnecting, setReconnecting] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [report, setReport] = useState<{ runId: string; markdown: string } | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [note, setNote] = useState<{ runId: string; text: string } | null>(null);
  const eventLog = useRef<HTMLDivElement>(null);
  const snapshotRevision = useRef(0);
  const runId = typeof snapshot.run?.id === 'string' ? snapshot.run.id : undefined;
  const status = display(snapshot.run?.status, 'UNKNOWN');
  const onStreamError = useEffectEvent((error: unknown) => {
    onToast(error instanceof Error ? error.message : String(error), 'err');
  });

  useEffect(() => {
    setSnapshot(emptySnapshot);
    setReconnecting(false);

    let source: EventSource;
    try {
      source = new EventSource(client.streamUrl());
    } catch (error) {
      onStreamError(error);
      return;
    }

    function receiveSnapshot({ data }: MessageEvent<string>) {
      try {
        const next: unknown = JSON.parse(data);
        if (!isSnapshot(next)) throw new Error('Invalid live run snapshot.');
        snapshotRevision.current += 1;
        setSnapshot(withRecentEvents(next));
        setReconnecting(false);
      } catch (error) {
        onStreamError(error);
      }
    }

    function receiveEvent({ data }: MessageEvent<string>) {
      try {
        const event: unknown = JSON.parse(data);
        if (!isRow(event)) throw new Error('Invalid live run event.');
        snapshotRevision.current += 1;
        setSnapshot((current) => {
          if (current.run && typeof event.run_id === 'string' && event.run_id !== current.run.id) return current;
          // The server sends a snapshot before replaying the same newly added events by ID.
          const lastId = current.events.at(-1)?.id;
          if (typeof event.id === 'number' && typeof lastId === 'number' && event.id <= lastId) return current;
          return withRecentEvents({ ...current, events: [...current.events, event] });
        });
        setReconnecting(false);
      } catch (error) {
        onStreamError(error);
      }
    }

    source.addEventListener('snapshot', receiveSnapshot);
    source.addEventListener('event', receiveEvent);
    source.onopen = () => setReconnecting(false);
    source.onerror = () => setReconnecting(true);
    return () => {
      snapshotRevision.current += 1;
      source.removeEventListener('snapshot', receiveSnapshot);
      source.removeEventListener('event', receiveEvent);
      source.onopen = null;
      source.onerror = null;
      source.close();
    };
  }, [client]);

  useEffect(() => {
    if (visible && eventLog.current) eventLog.current.scrollTop = eventLog.current.scrollHeight;
  }, [visible, snapshot.events]);

  async function refreshLatestRun() {
    const revision = ++snapshotRevision.current;
    try {
      const latest = await client.getLatestRun();
      // A snapshot or event may have arrived since the HTTP request began.
      if (revision === snapshotRevision.current) setSnapshot(withRecentEvents(latest));
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    }
  }

  async function showReport() {
    if (!runId || loadingReport) return;
    setLoadingReport(true);
    try {
      const markdown = await client.getRunReport(runId);
      setReport({ runId, markdown });
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      setLoadingReport(false);
    }
  }

  async function changeRun(action: RunAction) {
    if (!runId || controlling) return;
    setControlling(true);
    try {
      if (action === 'pause' || action === 'resume') {
        await client.controlRun(runId, action);
      } else {
        await client.resolveRun(runId, action, note?.runId === runId ? note.text : '');
        setNote(null);
      }
      await refreshLatestRun();
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      setControlling(false);
    }
  }

  return (
    <section className="right-inspector__section right-inspector__live" aria-label={messages.inspector.liveSectionAria}>
      <div className="right-inspector__heading">
        <h2 className="panel__title">{messages.inspector.liveTitle}</h2>
        {reconnecting && <span className="pill pill--warn" role="status">{messages.inspector.reconnecting}</span>}
      </div>
      <div className="right-inspector__actions">
        <button className="btn btn--primary" type="button" onClick={() => setStartOpen(true)}>
          {messages.inspector.startRealRun}
        </button>
        {runId && (
          <button className="btn" type="button" onClick={() => void showReport()} disabled={loadingReport}>
            {messages.inspector.battleReport}
          </button>
        )}
      </div>
      {runId ? (
        <>
          <div className="right-inspector__heading">
            <span className={`pill ${statusStyles.get(status) ?? 'pill--muted'}`} role="status">
              {messages.inspector.runStatuses[status] ?? status}
            </span>
            <code>{runId}</code>
          </div>
          {(status === 'RUNNING' || status === 'PAUSED') && (
            <div className="right-inspector__actions">
              <button
                className="btn"
                type="button"
                disabled={controlling}
                onClick={() => void changeRun(status === 'RUNNING' ? 'pause' : 'resume')}
              >
                {status === 'RUNNING' ? messages.inspector.pauseRun : messages.inspector.resumeRun}
              </button>
            </div>
          )}
          {status === 'WAITING_HUMAN' && (
            <>
              <label className="right-inspector__field">
                <span>{messages.inspector.decisionNote}</span>
                <input
                  className="input"
                  value={note?.runId === runId ? note.text : ''}
                  disabled={controlling}
                  onChange={(event) => setNote({ runId, text: event.currentTarget.value })}
                />
              </label>
              <div className="right-inspector__actions">
                <button className="btn btn--primary" type="button" disabled={controlling} onClick={() => void changeRun('approve')}>
                  {messages.inspector.approve}
                </button>
                <button className="btn btn--danger" type="button" disabled={controlling} onClick={() => void changeRun('reject')}>
                  {messages.inspector.reject}
                </button>
              </div>
            </>
          )}
          <div className="right-inspector__tasks" tabIndex={0} role="region" aria-label={messages.inspector.tasksAria}>
            <table className="table">
              <thead>
                <tr>
                  <th>{messages.inspector.table.id}</th>
                  <th>{messages.inspector.table.title}</th>
                  <th>{messages.inspector.table.tier}</th>
                  <th>{messages.inspector.table.status}</th>
                  <th>{messages.inspector.table.assignee}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.tasks.map((task, index) => {
                  const taskStatus = display(task.status);
                  return (
                    <tr key={display(task.id, `task-${index}`)}>
                      <td><code>{display(task.id)}</code></td>
                      <td>{display(task.title)}</td>
                      <td>{display(task.tier)}</td>
                      <td>{messages.inspector.runStatuses[taskStatus] ?? taskStatus}</td>
                      <td>{display(task.current_role ?? task.assignee_role)}</td>
                    </tr>
                  );
                })}
                {snapshot.tasks.length === 0 && <tr><td colSpan={5}>{messages.inspector.noTasks}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="right-inspector__muted">{messages.inspector.noRuns}</p>
      )}
      <div className="right-inspector__section">
        <h3 className="right-inspector__label">{messages.inspector.eventLogTitle}</h3>
        <div
          className="right-inspector__event-log right-inspector__mono"
          ref={eventLog}
          role="log"
          aria-label={messages.inspector.eventLogAria}
          tabIndex={0}
        >
          {snapshot.events.map((event, index) => (
            <div className="right-inspector__event" key={display(event.id, `event-${index}`)}>
              <span className="right-inspector__event-kind">{display(event.kind, 'event')}</span>
              <span>{[display(event.task_id, ''), display(event.message, '')].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
          {snapshot.events.length === 0 && <p className="right-inspector__muted">{messages.inspector.noEvents}</p>}
        </div>
      </div>
      {visible && report && (
        <Modal open title={messages.inspector.modalReportTitle} onClose={() => setReport(null)}>
          <code className="right-inspector__muted">{report.runId}</code>
          <pre className="right-inspector__report">{report.markdown}</pre>
        </Modal>
      )}
      {startOpen && (
        <StartRunModal
          client={client}
          onToast={onToast}
          onClose={() => setStartOpen(false)}
          onStarted={() => void refreshLatestRun()}
        />
      )}
    </section>
  );
}
