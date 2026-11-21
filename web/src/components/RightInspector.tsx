import './RightInspector.css';
import './ui/ui.css';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { EdgeEditor, NodeEditor } from './inspector/GraphEditor';
import { LiveRunPanel } from './inspector/LiveRunPanel';
import type { RightInspectorProps } from './types';

const tabs = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'trace', label: 'Trace & Live Run' },
] as const;

type InspectorTab = typeof tabs[number]['id'];

function GraphDetails({ graph }: Pick<RightInspectorProps, 'graph'>) {
  return (
    <dl className="right-inspector__details">
      <dt>ID</dt><dd><code>{graph.id}</code></dd>
      <dt>Name</dt><dd>{graph.name}</dd>
      <dt>Difficulty</dt><dd>{graph.difficulty ?? '—'}</dd>
      <dt>Description</dt><dd>{graph.description ?? '—'}</dd>
      <dt>Nodes</dt><dd>{graph.nodes.length}</dd>
      <dt>Edges</dt><dd>{graph.edges.length}</dd>
    </dl>
  );
}

export function RightInspector({
  mode, client, graph, selectedNodeId, selectedEdgeId, onUpdateNode, onUpdateEdge,
  trace, stepIndex, onJumpToStep, onToast,
}: RightInspectorProps) {
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
    <aside className="right-inspector" aria-label="Workflow inspector">
      <div className="tabs right-inspector__tabs" role="tablist" aria-label="Workflow inspector views">
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
        <section className="right-inspector__section" aria-label="Simulation trace">
          <h2 className="panel__title">Trace</h2>
          {trace.length === 0 ? <p className="right-inspector__muted">No trace yet.</p> : (
            <ol className="right-inspector__trace">
              {trace.map((row, index) => {
                const active = index === activeIndex;
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
                        <strong>{row.kind}</strong>
                        {(row.node_id || row.edge_id || row.outcome) && (
                          <span className="right-inspector__muted right-inspector__mono">
                            {[row.node_id, row.edge_id, row.outcome].filter(Boolean).join(' · ')}
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
