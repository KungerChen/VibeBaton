import './LeftSidebar.css';
import './ui/ui.css';
import { useId, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Activity, ChevronDown, Coins, Download, Link2, Upload } from 'lucide-react';
import { computeLiveSeconds, formatDurationSec, isRunStatusActive } from '../engine/liveClock';
import { validateGraph } from '../engine/localSimulator';
import { useI18n } from '../i18n';
import { translatePresetText } from '../i18n/presets';
import { cn } from '../lib/utils';
import {
  NODE_TYPES,
  tierForNodeType,
  type BudgetProfile,
  type WorkflowEdge,
  type WorkflowGraph,
} from '../types/graph';
import { NODE_ICONS, TIER_COLORS } from './nodes/BatonNode';
import { filterPresets, getPresetBadges, RECIPE_FILTERS, type RecipeFilter } from './recipePlaza';
import type { LeftSidebarProps } from './types';
import { Badge, type BadgeProps } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';

const BUDGET_PROFILES = ['eco', 'balanced', 'max_quality'] as const satisfies readonly BudgetProfile[];

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
  budgetProfile,
  budgetProfileSaving,
  onBudgetProfileChange,
  currentGraphId,
  onSelectPreset,
  onAddNode,
  onImportGraph,
  onExport,
  onShare,
  validation,
  liveSnapshot,
  liveViewActive = false,
  liveNowSec,
  onSelectLiveRun,
}: LeftSidebarProps) {
  const { locale, messages } = useI18n();
  const { budgetProfile: budget, recipePlaza: plaza } = messages;
  const sidebarId = useId();
  const listId = `${sidebarId}-presets`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestImport = useRef(0);
  const [filter, setFilter] = useState<RecipeFilter>('all');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const visiblePresets = filterPresets(presets, filter);
  const providerList = new Intl.ListFormat(locale);

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

  const liveRunId = typeof liveSnapshot?.run?.id === 'string' ? liveSnapshot.run.id : null;
  const liveRunStatus = typeof liveSnapshot?.run?.status === 'string' ? liveSnapshot.run.status : 'UNKNOWN';
  const liveIsRunning = liveRunStatus === 'RUNNING' || liveRunStatus === 'PLANNING' || liveRunStatus === 'IN_PROGRESS';
  const livePassedTasks = liveSnapshot?.tasks.filter((task) => task.status === 'PASSED').length ?? 0;
  const liveTotalTasks = liveSnapshot?.tasks.length ?? 0;
  const liveElapsedSec = liveSnapshot?.telemetry?.elapsed_sec
    ?? (typeof liveSnapshot?.run?.created_at === 'number'
      ? Math.max(
        0,
        (typeof liveSnapshot.run.finished_at === 'number'
          ? liveSnapshot.run.finished_at
          : typeof liveSnapshot.run.updated_at === 'number'
            ? liveSnapshot.run.updated_at
            : liveSnapshot.run.created_at) - liveSnapshot.run.created_at,
      )
      : 0);
  const isActive = isRunStatusActive(liveSnapshot?.run?.status);
  const serverNow = liveSnapshot?.telemetry?.server_now;
  const isTicking = isActive && liveNowSec !== undefined && Number.isFinite(serverNow);
  // telemetry.elapsed_sec already covers in-flight work up to server_now, so advance
  // from the snapshot timestamp to avoid double-counting the current stage.
  const elapsed = computeLiveSeconds(
    liveElapsedSec,
    serverNow,
    isTicking,
    liveNowSec ?? 0,
  );

  return (
    <aside className="left-sidebar border-e border-border bg-card">
      {liveRunId && onSelectLiveRun && (
        <section className="left-sidebar__section" aria-label={messages.sidebar.liveRunTitle}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="left-sidebar__title">{messages.sidebar.liveRunTitle}</h2>
            <span className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
              {formatDurationSec(elapsed, locale, isTicking)}
              {isActive && (
                <span className="live-badge inline-flex items-center rounded-full border border-emerald-500/30 bg-[var(--emerald-soft)] px-1.5 py-0 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--emerald)]">
                  {messages.liveClock.live}
                </span>
              )}
            </span>
          </div>
          <Card
            data-tour-id="live-run-card"
            className={cn(
              'min-w-0 transition-colors',
              liveViewActive
                ? 'border-primary/55 bg-[var(--accent-soft)] ring-1 ring-primary/30'
                : 'bg-muted/45 hover:border-[var(--border-strong)] hover:bg-muted/80',
            )}
          >
            <button
              type="button"
              aria-pressed={liveViewActive}
              onClick={onSelectLiveRun}
              className="left-sidebar__preset cursor-pointer rounded-xl p-2.5 text-start"
            >
              <span className="flex w-full min-w-0 items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-text-strong">
                  <Activity size={13} className="shrink-0 text-primary" aria-hidden="true" />
                  <span className="truncate font-mono text-[11.5px]" title={liveRunId}>
                    {liveRunId}
                  </span>
                </span>
                <Badge
                  variant={liveIsRunning ? 'info' : liveRunStatus === 'COMPLETED' ? 'success' : 'warning'}
                  className="shrink-0 gap-1 px-1.5 py-0 text-[9.5px]"
                >
                  {liveIsRunning && <span className="left-sidebar__live-pulse" aria-hidden="true" />}
                  {messages.inspector.runStatuses[liveRunStatus] ?? liveRunStatus}
                </Badge>
              </span>
              <span className="flex items-center justify-between gap-2 text-[11px] font-mono text-muted-foreground">
                <span>{messages.sidebar.liveRunTasks(livePassedTasks, liveTotalTasks)}</span>
                {liveViewActive && (
                  <span className="font-sans text-[10.5px] font-semibold text-primary">
                    {messages.sidebar.liveRunActiveBadge}
                  </span>
                )}
              </span>
              <span className="text-[11px] leading-snug text-muted-foreground">
                {messages.sidebar.liveRunHint}
              </span>
            </button>
          </Card>
        </section>
      )}

      <fieldset className="m-0 min-w-0 border-0 p-0" disabled={budgetProfile === null} aria-busy={budgetProfileSaving} data-tour-id="budget-profile">
        <legend className="left-sidebar__title">{budget.label}</legend>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/65 p-1">
          {BUDGET_PROFILES.map((profile) => {
            const { label, tooltip } = budget.options[profile];
            return (
              <label className="min-w-0" key={profile} title={tooltip}>
                <input
                  className="peer sr-only"
                  type="radio"
                  name={`${sidebarId}-budget`}
                  value={profile}
                  checked={budgetProfile === profile}
                  aria-description={tooltip}
                  aria-disabled={budgetProfileSaving || undefined}
                  onChange={() => onBudgetProfileChange(profile)}
                />
                <span className="left-sidebar__budget-segment block cursor-pointer rounded-md px-1 py-1.5 text-center text-[11px] font-semibold text-muted-foreground transition-colors hover:text-text-strong peer-checked:bg-card peer-checked:text-text-strong peer-checked:shadow-xs peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-default peer-disabled:opacity-50">
                  {label}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <section className="left-sidebar__section" data-tour-id="recipe-plaza">
        <div className="flex items-center justify-between gap-2">
          <h2 className="left-sidebar__title">{plaza.title}</h2>
          <output className="text-[11px] font-mono text-muted-foreground" aria-label={plaza.title}>
            {visiblePresets.length.toLocaleString(locale)}
          </output>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={plaza.title}>
          {RECIPE_FILTERS.map((item) => (
            <Button
              key={item}
              variant={item === filter ? 'default' : 'outline'}
              size="xs"
              className="rounded-full"
              aria-pressed={item === filter}
              aria-controls={listId}
              onClick={() => setFilter(item)}
            >
              {plaza.filters[item]}
            </Button>
          ))}
        </div>
        <div className="left-sidebar__presets" id={listId}>
          {visiblePresets.map((preset) => {
            const active = !liveViewActive && preset.id === currentGraphId;
            const badgeVariant = difficultyVariants.get(preset.difficulty) ?? 'outline';
            const difficultyLabel = messages.sidebar.difficulty[preset.difficulty] ?? preset.difficulty;
            const presetName = translatePresetText(preset.name, locale);
            const { readiness, cost } = getPresetBadges(preset);
            const missingProviders = readiness?.missingProviders.length
              ? providerList.format(readiness.missingProviders)
              : undefined;

            return (
              <Card
                key={preset.id}
                className={cn(
                  'min-w-0 transition-colors',
                  active
                    ? 'border-primary/50 bg-[var(--accent-soft)] ring-1 ring-primary/25'
                    : 'bg-muted/40 hover:border-[var(--border-strong)] hover:bg-muted/80',
                )}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  aria-description={missingProviders}
                  onClick={() => onSelectPreset(preset.id)}
                  className="left-sidebar__preset cursor-pointer rounded-xl p-2.5 text-start"
                >
                  <span className="flex w-full min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold text-text-strong" title={presetName}>
                      {presetName}
                    </span>
                    <Badge variant={badgeVariant} className="shrink-0 px-1.5 py-0 text-[9.5px] uppercase tracking-wide">
                      {difficultyLabel}
                    </Badge>
                  </span>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {messages.sidebar.presetCounts(preset.node_count, preset.edge_count)}
                  </span>
                  {(readiness || cost) && (
                    <span className="flex flex-wrap gap-1.5">
                      {readiness && (
                        <Badge variant={readiness.variant} title={missingProviders} className="px-1.5">
                          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                          {plaza[readiness.label]}
                        </Badge>
                      )}
                      {cost && (
                        <Badge variant={cost.variant} className="px-1.5">
                          <Coins size={11} aria-hidden="true" />
                          {plaza.costTiers[cost.tier]}
                        </Badge>
                      )}
                    </span>
                  )}
                </button>
              </Card>
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
