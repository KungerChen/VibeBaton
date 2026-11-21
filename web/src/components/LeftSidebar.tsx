import './LeftSidebar.css';
import './ui/ui.css';
import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { ChevronDown, Download, Link2, Upload } from 'lucide-react';
import { validateGraph } from '../engine/localSimulator';
import { NODE_TYPES, tierForNodeType, type WorkflowEdge, type WorkflowGraph } from '../types/graph';
import { NODE_ICONS, TIER_COLORS } from './nodes/BatonNode';
import type { LeftSidebarProps } from './types';

const difficultyClasses = new Map([
  ['beginner', 'left-sidebar__difficulty--beginner'],
  ['intermediate', 'left-sidebar__difficulty--intermediate'],
  ['pro', 'left-sidebar__difficulty--pro'],
  ['expert', 'left-sidebar__difficulty--expert'],
]);

type ImportedEdge = Omit<WorkflowEdge, 'max_loops'> & {
  source_handle?: string;
  target_handle?: string;
  max_loops?: number | boolean | null;
  maxLoops?: number | boolean | null;
};

// Convert the legacy edge fields accepted by validateGraph to the canvas format.
function canonicalizeEdge(input: ImportedEdge): WorkflowEdge {
  const {
    source_handle,
    target_handle,
    maxLoops,
    sourceHandle = source_handle,
    targetHandle = target_handle,
    max_loops = maxLoops,
    ...rest
  } = input;
  const edge: WorkflowEdge = rest;
  if (sourceHandle !== undefined) edge.sourceHandle = sourceHandle;
  if (targetHandle !== undefined) edge.targetHandle = targetHandle;
  if (max_loops != null) edge.max_loops = Number(max_loops);
  return edge;
}

export function LeftSidebar({
  presets,
  currentGraphId,
  onSelectPreset,
  onAddNode,
  onImportGraph,
  onExport,
  onShare,
  validation,
}: LeftSidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestImport = useRef(0);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [warningsOpen, setWarningsOpen] = useState(false);

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const importId = ++latestImport.current;
    setImportErrors([]);
    try {
      const fileText = await file.text();
      if (importId !== latestImport.current) return;

      const graph = JSON.parse(fileText) as WorkflowGraph;
      const result = validateGraph(graph);
      if (!result.valid) {
        setImportErrors(result.errors);
        return;
      }

      const invalidRoleIndex = graph.nodes.findIndex(({ role }) => role !== undefined && typeof role !== 'string');
      if (invalidRoleIndex !== -1) {
        setImportErrors([`nodes[${invalidRoleIndex}].role must be a string`]);
        return;
      }

      onImportGraph({ ...graph, edges: graph.edges.map(canonicalizeEdge) });
    } catch (error) {
      if (importId === latestImport.current) {
        setImportErrors([error instanceof Error ? error.message : String(error)]);
      }
    }
  };

  return (
    <aside className="left-sidebar">
      <section className="left-sidebar__section">
        <h2 className="left-sidebar__title">Presets</h2>
        <div className="left-sidebar__presets">
          {presets.map((preset) => {
            const active = preset.id === currentGraphId;
            const difficultyClass = difficultyClasses.get(preset.difficulty)
              ?? 'left-sidebar__difficulty--slate';

            return (
              <button
                key={preset.id}
                className={`left-sidebar__preset${active ? ' left-sidebar__preset--active' : ''}`}
                type="button"
                aria-pressed={active}
                onClick={() => onSelectPreset(preset.id)}
              >
                <span className="left-sidebar__preset-header">
                  <span className="left-sidebar__preset-name">{preset.name}</span>
                  <span className={`left-sidebar__difficulty ${difficultyClass}`} title={preset.difficulty}>
                    {preset.difficulty}
                  </span>
                </span>
                <span className="left-sidebar__preset-meta">
                  {preset.node_count} nodes · {preset.edge_count} edges
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="left-sidebar__section">
        <h2 className="left-sidebar__title">Node Palette</h2>
        <div className="left-sidebar__palette">
          {NODE_TYPES.map((type) => {
            const Icon = NODE_ICONS[type];
            const accent = TIER_COLORS[tierForNodeType(type)];
            const label = type.replace(/_node$/, '');

            return (
              <button
                key={type}
                className="left-sidebar__node"
                type="button"
                draggable
                style={{ '--node-accent': accent } as CSSProperties}
                onClick={() => onAddNode(type)}
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/vibebaton-node', type);
                }}
              >
                <Icon className="left-sidebar__node-icon" size={16} aria-hidden="true" />
                <span className="left-sidebar__node-label" title={label}>{label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="left-sidebar__section">
        <h2 className="left-sidebar__title">Import / Export</h2>
        <div className="left-sidebar__actions">
          <button
            className="btn left-sidebar__action"
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={16} aria-hidden="true" />
            Import .baton.json
          </button>
          <input
            ref={fileInputRef}
            className="left-sidebar__file-input"
            type="file"
            accept=".json,application/json"
            hidden
            onChange={handleImport}
          />
          <button className="btn left-sidebar__action" type="button" onClick={onExport}>
            <Download size={16} aria-hidden="true" />
            Export JSON
          </button>
          {onShare && (
            <button className="btn left-sidebar__action" type="button" onClick={onShare}>
              <Link2 size={16} aria-hidden="true" />
              Share Link
            </button>
          )}
        </div>
        {importErrors.length > 0 && (
          <ul className="left-sidebar__import-errors" role="alert">
            {importErrors.map((error, index) => (
              <li key={`${index}-${error}`}>{error}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="left-sidebar__section">
        <h2 className="left-sidebar__title">Validation</h2>
        {validation === null ? (
          <span className="pill pill--muted" role="status">Not validated</span>
        ) : !validation.valid ? (
          <div className="left-sidebar__validation">
            <span className="pill pill--err" role="status">
              Invalid · {validation.errors.length} errors
            </span>
            <ul className="left-sidebar__validation-list left-sidebar__validation-list--err">
              {validation.errors.map((error, index) => (
                <li key={`${index}-${error}`}>{error}</li>
              ))}
            </ul>
          </div>
        ) : validation.warnings.length === 0 ? (
          <span className="pill pill--ok" role="status">Valid</span>
        ) : (
          <div className="left-sidebar__validation">
            <button
              className="pill pill--warn left-sidebar__validation-toggle"
              type="button"
              aria-expanded={warningsOpen}
              onClick={() => setWarningsOpen((open) => !open)}
            >
              Valid · {validation.warnings.length} warnings
              <ChevronDown className="left-sidebar__validation-chevron" size={14} aria-hidden="true" />
            </button>
            {warningsOpen && (
              <ul className="left-sidebar__validation-list left-sidebar__validation-list--warn">
                {validation.warnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </aside>
  );
}
