import './LeftSidebar.css';
import './ui/ui.css';
import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { ChevronDown, Download, Link2, Upload } from 'lucide-react';
import { validateGraph } from '../engine/localSimulator';
import { useI18n } from '../i18n';
import { translatePresetText } from '../i18n/presets';
import { cn } from '../lib/utils';
import { NODE_TYPES, tierForNodeType, type WorkflowEdge, type WorkflowGraph } from '../types/graph';
import { NODE_ICONS, TIER_COLORS } from './nodes/BatonNode';
import type { LeftSidebarProps } from './types';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';

const difficultyVariants = new Map<string, BadgeProps['variant']>([
  ['beginner', 'success'],
  ['intermediate', 'info'],
  ['pro', 'violet'],
  ['expert', 'warning'],
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
  const { locale, messages } = useI18n();
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
        setImportErrors([messages.sidebar.roleMustBeString(invalidRoleIndex)]);
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
    <aside className="left-sidebar border-e border-border bg-card">
      <section className="left-sidebar__section">
        <h2 className="left-sidebar__title">{messages.sidebar.presetsTitle}</h2>
        <div className="left-sidebar__presets">
          {presets.map((preset) => {
            const active = preset.id === currentGraphId;
            const badgeVariant = difficultyVariants.get(preset.difficulty) ?? 'outline';
            const difficultyLabel = messages.sidebar.difficulty[preset.difficulty] ?? preset.difficulty;
            const presetName = translatePresetText(preset.name, locale);

            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={active}
                onClick={() => onSelectPreset(preset.id)}
                className={cn(
                  'left-sidebar__preset rounded-xl border p-3 text-start transition-all cursor-pointer',
                  active
                    ? 'border-primary/50 bg-[var(--accent-soft)] ring-1 ring-primary/25 shadow-xs'
                    : 'border-border bg-muted/40 hover:border-border-strong hover:bg-muted/80',
                )}
              >
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full transition-colors',
                        active ? 'bg-primary' : 'bg-border-strong',
                      )}
                    />
                    <span className="truncate text-[13px] font-semibold text-text-strong" title={presetName}>
                      {presetName}
                    </span>
                  </span>
                  <Badge variant={badgeVariant} className="shrink-0 px-1.5 py-0 text-[9.5px] uppercase tracking-wide">
                    {difficultyLabel}
                  </Badge>
                </div>
                <span className="ps-4 text-[11px] font-mono text-muted-foreground">
                  {messages.sidebar.presetCounts(preset.node_count, preset.edge_count)}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="left-sidebar__section">
        <h2 className="left-sidebar__title">{messages.sidebar.nodePaletteTitle}</h2>
        <div className="left-sidebar__palette">
          {NODE_TYPES.map((type) => {
            const Icon = NODE_ICONS[type];
            const accent = TIER_COLORS[tierForNodeType(type)];
            const label = messages.nodeTypes[type];

            return (
              <button
                key={type}
                className="left-sidebar__node rounded-xl border border-border bg-card px-2.5 py-2 text-xs font-medium text-text-strong shadow-xs transition-all hover:border-border-strong hover:bg-[var(--panel-hover)] hover:shadow-sm hover:-translate-y-0.5 active:translate-y-0"
                type="button"
                draggable
                style={{ '--node-accent': accent } as CSSProperties}
                onClick={() => onAddNode(type)}
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/vibebaton-node', type);
                }}
              >
                <span
                  className="left-sidebar__node-squircle flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
                  aria-hidden="true"
                >
                  <Icon size={13} />
                </span>
                <span className="truncate" title={label}>{label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="left-sidebar__section">
        <h2 className="left-sidebar__title">{messages.sidebar.importExportTitle}</h2>
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} aria-hidden="true" />
            <span>{messages.sidebar.importButton}</span>
          </Button>
          <input
            ref={fileInputRef}
            className="hidden"
            type="file"
            accept=".json,application/json"
            hidden
            onChange={handleImport}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={onExport}
          >
            <Download size={14} aria-hidden="true" />
            <span>{messages.sidebar.exportButton}</span>
          </Button>
          {onShare && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={onShare}
            >
              <Link2 size={14} aria-hidden="true" />
              <span>{messages.sidebar.shareButton}</span>
            </Button>
          )}
        </div>

        {importErrors.length > 0 && (
          <ul
            className="m-0 grid gap-1 rounded-xl border border-rose-500/35 bg-[var(--rose-soft)] p-2.5 text-xs text-[var(--rose)] list-none"
            role="alert"
          >
            {importErrors.map((error, index) => (
              <li key={`${index}-${error}`}>{error}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="left-sidebar__section">
        <h2 className="left-sidebar__title">{messages.sidebar.validationTitle}</h2>
        {validation === null ? (
          <Badge variant="outline" className="self-start" role="status">
            {messages.sidebar.notValidated}
          </Badge>
        ) : !validation.valid ? (
          <div className="flex flex-col items-start gap-2 min-w-0">
            <Badge variant="destructive" role="status">
              {messages.sidebar.invalidWithErrors(validation.errors.length)}
            </Badge>
            <ul className="m-0 grid gap-1 ps-4 text-xs text-[var(--rose)]">
              {validation.errors.map((error, index) => (
                <li key={`${index}-${error}`}>{error}</li>
              ))}
            </ul>
          </div>
        ) : validation.warnings.length === 0 ? (
          <Badge variant="success" className="self-start" role="status">
            {messages.sidebar.valid}
          </Badge>
        ) : (
          <div className="flex flex-col items-start gap-2 min-w-0">
            <button
              className="pill pill--warn left-sidebar__validation-toggle"
              type="button"
              aria-expanded={warningsOpen}
              onClick={() => setWarningsOpen((open) => !open)}
            >
              {messages.sidebar.validWithWarnings(validation.warnings.length)}
              <ChevronDown className="left-sidebar__validation-chevron transition-transform" size={14} aria-hidden="true" />
            </button>
            {warningsOpen && (
              <ul className="m-0 grid gap-1 ps-4 text-xs text-[var(--amber)]">
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
