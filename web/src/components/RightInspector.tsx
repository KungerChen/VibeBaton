import './RightInspector.css';
import './ui/ui.css';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { DEMO_ROLES_CONFIG } from '../data/demoConfig';
import { isRunStatusActive } from '../engine/liveClock';
import { useI18n } from '../i18n';
import { translateHandle, translatePresetText } from '../i18n/presets';
import { cn } from '../lib/utils';
import { updateWorkspaceReadiness, useWorkspaceReadiness } from './CanvasWorkspace';
import { EdgeEditor, NodeEditor } from './inspector/GraphEditor';
import { LiveRunPanel } from './inspector/LiveRunPanel';
import { LaunchGraphContext } from './inspector/wizard/PreflightStep';
import { getPresetProviderHealth } from './nodes/readiness';
import type { NodeDoctorProps, RightInspectorProps } from './types';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

type InspectorTab = 'inspector' | 'trace';

const DIFFICULTY_BADGE: Record<string, BadgeProps['variant']> = {
  beginner: 'success',
  intermediate: 'info',
  pro: 'violet',
  expert: 'warning',
  live: 'info',
};

function GraphDetails({
  graph,
  mode,
  liveRunning,
  onOpenTrace,
  onOpenStartRun,
}: Pick<RightInspectorProps, 'graph' | 'mode' | 'onOpenStartRun'> & {
  liveRunning: boolean;
  onOpenTrace(): void;
}) {
  const { locale, messages } = useI18n();
  const difficultyLabel = graph.difficulty
    ? messages.sidebar.difficulty[graph.difficulty] ?? graph.difficulty
    : '—';
  const badgeVariant = graph.difficulty ? (DIFFICULTY_BADGE[graph.difficulty] ?? 'secondary') : 'secondary';

  return (
    <div className="grid gap-3">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle>{translatePresetText(graph.name, locale)}</CardTitle>
            {graph.difficulty && (
              <Badge variant={badgeVariant} className="shrink-0 uppercase text-[10px]">
                {difficultyLabel}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 pt-0.5">
            <span className="text-[11px] text-muted-foreground">{messages.inspector.detailsId}:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-text-strong">
              {graph.id}
            </code>
          </div>
        </CardHeader>
        <CardContent>
          <CardDescription>
            {graph.description ? translatePresetText(graph.description, locale) : '—'}
          </CardDescription>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-xl border border-border bg-muted/45 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {messages.inspector.detailsNodes}
          </div>
          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-text-strong">
            {graph.nodes.length}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-muted/45 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {messages.inspector.detailsEdges}
          </div>
          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-text-strong">
            {graph.edges.length}
          </div>
        </div>
      </div>

      <div className="grid gap-2.5 rounded-xl border border-dashed border-border bg-muted/30 p-3">
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">
          {messages.inspector.emptyHint}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOpenTrace}>
            {liveRunning && (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--emerald)] animate-pulse" aria-hidden="true" />
            )}
            <span>{messages.inspector.openTraceLive}</span>
          </Button>
          {mode === 'local' && onOpenStartRun && (
            <Button variant="default" size="sm" onClick={onOpenStartRun}>
              {messages.inspector.startRealRun}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function RightInspector({
  mode, client, graph, selectedNodeId, selectedEdgeId, onUpdateNode, onUpdateEdge,
  trace, stepIndex, onJumpToStep, onToast,
  liveSnapshot, recentRuns, selectedRunId, runSynced = true, runSyncStatus = 'synced',
  liveReconnecting, onSelectRunId, onRefreshLiveRun, onOpenStartRun,
  liveNowSec, openBattleReportToken,
}: RightInspectorProps) {
  const { locale, messages } = useI18n();
  const tabs: readonly { id: InspectorTab; label: string }[] = [
    { id: 'inspector', label: messages.inspector.tabInspector },
    { id: 'trace', label: messages.inspector.tabTrace },
  ];
  const [tab, setTab] = useState<InspectorTab>('inspector');
  const prevSelectionRef = useRef<{ nodeId: string | null; edgeId: string | null }>({
    nodeId: selectedNodeId,
    edgeId: selectedEdgeId,
  });

  useEffect(() => {
    const prev = prevSelectionRef.current;
    prevSelectionRef.current = { nodeId: selectedNodeId, edgeId: selectedEdgeId };
    if (
      (selectedNodeId !== null || selectedEdgeId !== null)
      && (selectedNodeId !== prev.nodeId || selectedEdgeId !== prev.edgeId)
    ) {
      setTab('inspector');
    }
  }, [selectedNodeId, selectedEdgeId]);
  const { doctorTargets } = useWorkspaceReadiness();
  const providers = Object.keys(doctorTargets?.providers ?? {}).sort();
  const activeWorkspace = useRef<(Pick<RightInspectorProps, 'client' | 'mode'> & {
    doctorSequenceByProvider: Map<string, number>;
  }) | null>(null);
  const id = useId();
  const providerListId = `${id}-providers`;
  const activeRow = useRef<HTMLButtonElement>(null);
  const activeIndex = stepIndex - 1;
  const node = graph.nodes.find(({ id }) => id === selectedNodeId);
  const edge = graph.edges.find(({ id }) => id === selectedEdgeId);
  const onRolesError = useEffectEvent((error: unknown) => {
    onToast(error instanceof Error ? error.message : String(error), 'err');
  });

  useEffect(() => {
    activeWorkspace.current = { client, mode, doctorSequenceByProvider: new Map() };
    let active = true;

    updateWorkspaceReadiness((current) => {
      const providerHealth = new Map(current.providerHealth);
      const quotas = client.health?.quotas;
      if (mode === 'local' && Array.isArray(quotas)) {
        for (const quota of quotas as unknown[]) {
          if (!quota || typeof quota !== 'object' || !('provider' in quota) || !('cooldown_until' in quota)) continue;
          const { provider, cooldown_until } = quota;
          if (typeof provider !== 'string' || typeof cooldown_until !== 'number' || !Number.isFinite(cooldown_until)) continue;
          const previous = providerHealth.get(provider);
          providerHealth.set(provider, { provider, ok: false, detail: '', ...previous, cooldown_until });
        }
      }
      return { providerHealth, doctorTargets: mode === 'demo' ? DEMO_ROLES_CONFIG : undefined };
    });

    void client.listPresets().then((presets) => {
      if (!active) return;
      updateWorkspaceReadiness((current) => {
        const providerHealth = new Map(current.providerHealth);
        for (const [provider, health] of getPresetProviderHealth(presets)) {
          const previous = providerHealth.get(provider);
          // A Doctor response replaces the catalog summary for this workspace session.
          if (previous?.latency_ms === undefined) {
            providerHealth.set(provider, { ...health, cooldown_until: previous?.cooldown_until });
          }
        }
        return { ...current, providerHealth };
      });
    }, () => {
      // The workspace already reports catalog request failures in the sidebar.
    });

    async function loadProviders() {
      try {
        const config = await client.getRoles();
        if (active && config) {
          updateWorkspaceReadiness((current) => ({ ...current, doctorTargets: config }));
        }
      } catch (error) {
        if (active) onRolesError(error);
      }
    }

    if (mode === 'local') void loadProviders();
    return () => {
      active = false;
      activeWorkspace.current = null;
      updateWorkspaceReadiness();
    };
  }, [client, mode]);

  const onDoctorResult: NodeDoctorProps['onDoctorResult'] = (result, sequence, fallbackRole) => {
    const workspace = activeWorkspace.current;
    if (workspace?.client !== client || workspace.mode !== mode) return;
    if ((workspace.doctorSequenceByProvider.get(result.provider) ?? 0) > sequence) return;
    workspace.doctorSequenceByProvider.set(result.provider, sequence);
    updateWorkspaceReadiness((current) => {
      const providerHealth = new Map(current.providerHealth);
      const cooldown_until = providerHealth.get(result.provider)?.cooldown_until;
      providerHealth.set(result.provider, { ...result, cooldown_until });
      const targets = current.doctorTargets;
      if (!targets || !fallbackRole || !Object.hasOwn(targets.roles, fallbackRole)) {
        return { ...current, providerHealth };
      }

      const roles = {
        ...targets.roles,
        [fallbackRole]: { ...targets.roles[fallbackRole], provider: result.provider },
      };
      return { providerHealth, doctorTargets: { ...targets, roles } };
    });
  };

  useEffect(() => {
    if (tab === 'trace') activeRow.current?.scrollIntoView({ block: 'nearest' });
  }, [tab, activeIndex, trace]);

  return (
    <aside className="right-inspector border-s border-border bg-card" aria-label={messages.inspector.asideAria}>
      <div className="border-b border-border bg-card px-3.5 py-2.5">
        <div
          className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-muted/85 p-1"
          role="tablist"
          aria-label={messages.inspector.tablistAria}
        >
          {tabs.map(({ id: key, label }) => {
            const isSelected = tab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                id={`${id}-${key}-tab`}
                data-tour-id="inspector-live-tab"
                {...(key !== 'trace' && { 'data-tour-id': undefined })}
                aria-controls={`${id}-${key}`}
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => setTab(key)}
                onKeyDown={(event) => {
                  let nextTab: InspectorTab;
                  switch (event.key) {
                    case 'ArrowLeft':
                    case 'ArrowRight':
                      nextTab = key === 'inspector' ? 'trace' : 'inspector';
                      break;
                    case 'Home':
                      nextTab = 'inspector';
                      break;
                    case 'End':
                      nextTab = 'trace';
                      break;
                    default:
                      return;
                  }
                  event.preventDefault();
                  setTab(nextTab);
                  event.currentTarget.ownerDocument.getElementById(`${id}-${nextTab}-tab`)?.focus();
                }}
                className={cn(
                  'rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected
                    ? 'bg-card text-text-strong shadow-xs'
                    : 'text-muted-foreground hover:text-text-strong',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <section
        className="right-inspector__pane"
        role="tabpanel"
        id={`${id}-inspector`}
        aria-labelledby={`${id}-inspector-tab`}
        tabIndex={0}
        hidden={tab !== 'inspector'}
      >
        {mode === 'local' && (
          <datalist id={providerListId}>
            {providers.map((provider) => <option key={provider} value={provider} />)}
          </datalist>
        )}
        {node ? (
          <NodeEditor
            key={`${graph.id}:${node.id}`}
            node={node}
            mode={mode}
            client={client}
            providerListId={providerListId}
            onUpdateNode={onUpdateNode}
            onToast={onToast}
            doctorTargets={doctorTargets}
            onDoctorResult={onDoctorResult}
          />
        ) : edge ? (
          <EdgeEditor key={`${graph.id}:${edge.id}`} edge={edge} onUpdateEdge={onUpdateEdge} />
        ) : (
          <GraphDetails
            graph={graph}
            mode={mode}
            liveRunning={isRunStatusActive(liveSnapshot?.run?.status)}
            onOpenTrace={() => setTab('trace')}
            onOpenStartRun={onOpenStartRun}
          />
        )}
      </section>

      <section
        className="right-inspector__pane"
        role="tabpanel"
        id={`${id}-trace`}
        aria-labelledby={`${id}-trace-tab`}
        tabIndex={0}
        hidden={tab !== 'trace'}
      >
        <section className="right-inspector__section" aria-label={messages.inspector.traceAria}>
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground m-0">
            {messages.inspector.traceTitle}
          </h2>
          {trace.length === 0 ? (
            <p className="m-0 rounded-xl border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              {messages.inspector.noTrace}
            </p>
          ) : (
            <ol className="right-inspector__trace">
              {trace.map((row, index) => {
                const active = index === activeIndex;
                const localizedOutcome = row.outcome ? translateHandle(row.outcome, locale) : null;
                return (
                  <li key={row.seq}>
                    <button
                      type="button"
                      ref={active ? activeRow : null}
                      aria-current={active ? 'step' : undefined}
                      onClick={() => onJumpToStep(index + 1)}
                      className={cn(
                        'right-inspector__trace-row w-full rounded-xl border p-2.5 text-start text-xs transition-all cursor-pointer',
                        active
                          ? 'border-primary/50 bg-[var(--accent-soft)] ring-1 ring-primary/25'
                          : 'border-border bg-muted/35 hover:border-border-strong hover:bg-muted/70',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10.5px] font-bold',
                          active
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-card border border-border text-muted-foreground',
                        )}
                      >
                        {row.seq}
                      </span>
                      <span className="grid gap-0.5 min-w-0 overflow-wrap-anywhere">
                        <strong className="font-semibold text-text-strong">
                          {messages.playback.traceKinds[row.kind] ?? row.kind}
                        </strong>
                        {(row.node_id || row.edge_id || localizedOutcome) && (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {[row.node_id, row.edge_id, localizedOutcome].filter(Boolean).join(' · ')}
                          </span>
                        )}
                        <span className="text-foreground leading-snug">{row.message}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        {mode === 'local' && (
          <LaunchGraphContext.Provider value={graph}>
            <LiveRunPanel
              client={client}
              onToast={onToast}
              visible={tab === 'trace'}
              liveSnapshot={liveSnapshot}
              recentRuns={recentRuns}
              selectedRunId={selectedRunId}
              runSynced={runSynced}
              runSyncStatus={runSyncStatus}
              liveReconnecting={liveReconnecting}
              onSelectRunId={onSelectRunId}
              onRefreshLiveRun={onRefreshLiveRun}
              onOpenStartRun={onOpenStartRun}
              liveNowSec={liveNowSec}
              openBattleReportToken={openBattleReportToken}
            />
          </LaunchGraphContext.Provider>
        )}
      </section>
    </aside>
  );
}
