import './ContextDrawer.css';
import { useId, useState, type ReactNode } from 'react';
import { formatDurationSec } from '../../engine/liveClock';
import type { LiveRunGraphView } from '../../engine/liveRunGraph';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatProviderModel, translateRole } from '../../i18n/presets';
import type { ExecutionState, LiveRunSnapshot, WorkflowNode } from '../../types/graph';

/** Who the drawer shows, in priority order: a pending decision, the selected object, the run overview. */
export type DrawerOwner = 'decision' | 'task' | 'node' | 'handoff' | 'overview';

type DetailsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function drawerDetailsKey(panel: DrawerOwner): string {
  return `vibebaton.drawerDetails.${panel}`;
}

/** Whether the user last expanded the technical details of this panel type; collapsed when unknown. */
export function readDrawerDetails(storage: Pick<Storage, 'getItem'> | null, panel: DrawerOwner): boolean {
  try { return storage?.getItem(drawerDetailsKey(panel)) === 'open'; } catch { return false; }
}

export function writeDrawerDetails(storage: Pick<Storage, 'setItem'> | null, panel: DrawerOwner, open: boolean): void {
  try { storage?.setItem(drawerDetailsKey(panel), open ? 'open' : 'closed'); } catch { /* Storage may be unavailable. */ }
}

function browserStorage(): DetailsStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage ?? null; } catch { return null; }
}

/** The fixed side panel of Build: never a layer over the graph, never takes focus. */
export function ContextDrawer({ locale, owner, children }: { locale: Locale; owner: DrawerOwner; children?: ReactNode }) {
  return (
    <aside className="context-drawer" aria-label={MESSAGES[locale].guided.relay.drawerAria} data-owner={owner}>
      {children}
    </aside>
  );
}

/** One panel of the drawer; a panel that is not the owner stays mounted, hidden and out of reach. */
export function DrawerPanel({ panel, owner, children }: { panel: DrawerOwner; owner: DrawerOwner; children?: ReactNode }) {
  return <section className="context-drawer__panel" data-panel={panel} hidden={panel !== owner}>{children}</section>;
}

/** Technical details, collapsed by default; only the user's own toggle is remembered, per panel type. */
export function DrawerDetails({ panel, locale, children }: { panel: DrawerOwner; locale: Locale; children?: ReactNode }) {
  const bodyId = useId();
  const [open, setOpen] = useState(() => readDrawerDetails(browserStorage(), panel));
  return (
    <div className="context-drawer__details">
      <button type="button" className="context-drawer__details-toggle" aria-expanded={open} aria-controls={bodyId}
        onClick={() => { setOpen(!open); writeDrawerDetails(browserStorage(), panel, !open); }}>
        {MESSAGES[locale].guided.relay.details}
      </button>
      <div id={bodyId} className="context-drawer__details-body" hidden={!open}>{children}</div>
    </div>
  );
}

/** Planner, milestone review, final gate and panel nodes. */
export function RelayNodePanel({ node, state, locale }: { node: WorkflowNode; state: ExecutionState; locale: Locale }) {
  const copy = MESSAGES[locale].guided;
  const relay = copy.relay;
  const { provider, model, duration_sec: duration } = node.config ?? {};
  const modelText = formatProviderModel(typeof provider === 'string' ? provider : null, typeof model === 'string' ? model : null);
  return (
    <>
      <header className="context-drawer__head">
        <h2 className="context-drawer__title">{node.label}</h2>
      </header>
      <div className="context-drawer__upper">
        {relay.node.kinds[node.type] ? <p>{relay.node.kinds[node.type]}</p> : null}
        <p><span className="context-drawer__label">{relay.node.status}</span> <strong data-field="state">{relay.node.states[state]}</strong></p>
      </div>
      <DrawerDetails panel="node" locale={locale}>
        <dl className="context-drawer__facts">
          <dt>{relay.node.role}</dt>
          <dd data-field="role">{node.role ? translateRole(node.role, locale) : relay.unknown}</dd>
          <dt>{copy.nodeDetail.model}</dt>
          <dd data-field="model">{modelText || relay.unknown}</dd>
          <dt>{copy.nodeDetail.elapsed}</dt>
          <dd data-field="elapsed">{typeof duration === 'number' ? formatDurationSec(duration, locale) : relay.unknown}</dd>
        </dl>
      </DrawerDetails>
    </>
  );
}

/** Nothing selected and nothing to decide: how the run is doing and which step is working. */
export function RunOverviewPanel({ snapshot, view, locale }: { snapshot: LiveRunSnapshot; view: LiveRunGraphView; locale: Locale }) {
  const copy = MESSAGES[locale].guided.relay;
  const status = typeof snapshot.run?.status === 'string' ? snapshot.run.status : '';
  const done = snapshot.tasks.filter((task) => task.status === 'PASSED').length;
  const working = view.graph.nodes.filter((node) => view.nodeStates[node.id] === 'active').map((node) => node.label);
  return (
    <>
      <header className="context-drawer__head">
        <h2 className="context-drawer__title">{copy.overview.title}</h2>
      </header>
      <div className="context-drawer__upper">
        <p data-field="run-status">{copy.overview.statuses[status] ?? copy.overview.statusOther(status || copy.unknown)}</p>
        <p data-field="tasks-done">{copy.overview.tasksDone(done, snapshot.tasks.length)}</p>
        <p data-field="holder">{working.length
          ? copy.overview.holder(working.join(locale === 'zh' ? '、' : ', ')) : copy.overview.noHolder}</p>
        <p className="context-drawer__hint">{copy.overview.hint}</p>
      </div>
      <DrawerDetails panel="overview" locale={locale}>
        <dl className="context-drawer__facts">
          <dt>{copy.overview.runId}</dt>
          <dd><code>{String(snapshot.run?.id ?? copy.unknown)}</code></dd>
          <dt>{copy.overview.runStatus}</dt>
          <dd><code>{status || copy.unknown}</code></dd>
        </dl>
      </DrawerDetails>
    </>
  );
}
