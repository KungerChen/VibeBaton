import './RightInspector.css';
import './ui/ui.css';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { translateHandle, translatePresetText } from '../i18n/presets';
import { cn } from '../lib/utils';
import { EdgeEditor, NodeEditor } from './inspector/GraphEditor';
import { LiveRunPanel } from './inspector/LiveRunPanel';
import type { RightInspectorProps } from './types';
import { Badge, type BadgeProps } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

type InspectorTab = 'inspector' | 'trace';

const DIFFICULTY_BADGE: Record<string, BadgeProps['variant']> = {
  beginner: 'success',
  intermediate: 'info',
  pro: 'violet',
  expert: 'warning',
};

function GraphDetails({ graph }: Pick<RightInspectorProps, 'graph'>) {
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
    </div>
  );
}

export function RightInspector({
  mode, client, graph, selectedNodeId, selectedEdgeId, onUpdateNode, onUpdateEdge,
  trace, stepIndex, onJumpToStep, onToast,
}: RightInspectorProps) {
  const { locale, messages } = useI18n();
  const tabs: readonly { id: InspectorTab; label: string }[] = [
    { id: 'inspector', label: messages.inspector.tabInspector },
    { id: 'trace', label: messages.inspector.tabTrace },
  ];
  const [tab, setTab] = useState<InspectorTab>('inspector');
  const [providers, setProviders] = useState<string[]>([]);
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
    if (mode !== 'local') return;
    let active = true;

    async function loadProviders() {
      try {
        const config = await client.getRoles();
        if (active) setProviders(Object.keys(config?.providers ?? {}).sort());
      } catch (error) {
        if (active) onRolesError(error);
      }
    }

    setProviders([]);
    void loadProviders();
    return () => { active = false; };
  }, [client, mode]);

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
          />
        ) : edge ? (
          <EdgeEditor key={`${graph.id}:${edge.id}`} edge={edge} onUpdateEdge={onUpdateEdge} />
        ) : (
          <GraphDetails graph={graph} />
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
        {mode === 'local' && <LiveRunPanel client={client} onToast={onToast} visible={tab === 'trace'} />}
      </section>
    </aside>
  );
}
