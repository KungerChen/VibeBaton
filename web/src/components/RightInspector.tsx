import './RightInspector.css';
import './ui/ui.css';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { translateHandle, translatePresetText } from '../i18n/presets';
import { EdgeEditor, NodeEditor } from './inspector/GraphEditor';
import { LiveRunPanel } from './inspector/LiveRunPanel';
import type { RightInspectorProps } from './types';

type InspectorTab = 'inspector' | 'trace';

function GraphDetails({ graph }: Pick<RightInspectorProps, 'graph'>) {
  const { locale, messages } = useI18n();
  const difficultyLabel = graph.difficulty
    ? messages.sidebar.difficulty[graph.difficulty] ?? graph.difficulty
    : '—';

  return (
    <dl className="right-inspector__details">
      <dt>{messages.inspector.detailsId}</dt><dd><code>{graph.id}</code></dd>
      <dt>{messages.inspector.detailsName}</dt><dd>{translatePresetText(graph.name, locale)}</dd>
      <dt>{messages.inspector.detailsDifficulty}</dt><dd>{difficultyLabel}</dd>
      <dt>{messages.inspector.detailsDescription}</dt>
      <dd>{graph.description ? translatePresetText(graph.description, locale) : '—'}</dd>
      <dt>{messages.inspector.detailsNodes}</dt><dd>{graph.nodes.length}</dd>
      <dt>{messages.inspector.detailsEdges}</dt><dd>{graph.edges.length}</dd>
    </dl>
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
    <aside className="right-inspector" aria-label={messages.inspector.asideAria}>
      <div className="tabs right-inspector__tabs" role="tablist" aria-label={messages.inspector.tablistAria}>
        {tabs.map(({ id: key, label }) => (
          <button
            key={key}
            className={`tab${tab === key ? ' tab--active' : ''}`}
            type="button"
            role="tab"
            id={`${id}-${key}-tab`}
            aria-controls={`${id}-${key}`}
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
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
          >
            {label}
          </button>
        ))}
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
          <h2 className="panel__title">{messages.inspector.traceTitle}</h2>
          {trace.length === 0 ? <p className="right-inspector__muted">{messages.inspector.noTrace}</p> : (
            <ol className="right-inspector__trace">
              {trace.map((row, index) => {
                const active = index === activeIndex;
                const localizedOutcome = row.outcome ? translateHandle(row.outcome, locale) : null;
                return (
                  <li key={row.seq}>
                    <button
                      className="right-inspector__trace-row"
                      type="button"
                      ref={active ? activeRow : null}
                      aria-current={active ? 'step' : undefined}
                      onClick={() => onJumpToStep(index + 1)}
                    >
                      <span className="right-inspector__trace-seq">{row.seq}</span>
                      <span className="right-inspector__trace-content">
                        <strong>{messages.playback.traceKinds[row.kind] ?? row.kind}</strong>
                        {(row.node_id || row.edge_id || localizedOutcome) && (
                          <span className="right-inspector__muted right-inspector__mono">
                            {[row.node_id, row.edge_id, localizedOutcome].filter(Boolean).join(' · ')}
                          </span>
                        )}
                        <span>{row.message}</span>
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
