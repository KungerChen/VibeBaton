import './QuickStartModal.css';
import { ArrowRight, Check, Target } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import type { TierKey } from '../types/graph';
import { TIER_COLORS } from './nodes/BatonNode';
import { GuidedFlowDiagram, RelayPipelineDiagram, SandboxGuardDiagram } from './tutorial/TutorialDiagrams';
import { Button } from './ui/button';
import { Modal } from './ui/Modal';

export type QuickStartStepId = 'starter' | 'replay' | 'inspect';

export interface QuickStartModalProps {
  open: boolean;
  onClose(): void;
  completedSteps: ReadonlySet<QuickStartStepId>;
  dontShowAgain: boolean;
  onDontShowAgainChange(next: boolean): void;
  onTryStarter(): void;
  onWatchReplay(): void;
  onInspectWorker(): void;
  onStartTour?: () => void;
}

const TUTORIAL_DIAGRAMS = [RelayPipelineDiagram, GuidedFlowDiagram, SandboxGuardDiagram] as const;

const EDGE_SAMPLE_COLOR: Record<'normal' | 'retry' | 'escalate', string> = {
  normal: 'var(--emerald)',
  retry: 'var(--amber)',
  escalate: 'var(--rose)',
};

export function QuickStartModal({
  open,
  onClose,
  completedSteps,
  dontShowAgain,
  onDontShowAgainChange,
  onTryStarter,
  onWatchReplay,
  onInspectWorker,
  onStartTour,
}: QuickStartModalProps) {
  const { messages } = useI18n();
  const [tab, setTab] = useState<'quickstart' | 'legend' | 'tutorial'>('quickstart');
  const q = messages.quickStart;
  const startTourButton = onStartTour && (
    <Button
      variant="default"
      className="h-auto min-h-8 max-w-full whitespace-normal text-start"
      onClick={onStartTour}
    >
      <Target size={15} aria-hidden="true" />
      {messages.tour.startTourButton}
    </Button>
  );

  const steps: readonly {
    id: QuickStartStepId;
    num: number;
    title: string;
    desc: string;
    onRun(): void;
  }[] = [
    {
      id: 'starter',
      num: 1,
      title: q.steps.tryStarterTitle,
      desc: q.steps.tryStarterDesc,
      onRun: onTryStarter,
    },
    {
      id: 'replay',
      num: 2,
      title: q.steps.watchReplayTitle,
      desc: q.steps.watchReplayDesc,
      onRun: onWatchReplay,
    },
    {
      id: 'inspect',
      num: 3,
      title: q.steps.inspectNodeTitle,
      desc: q.steps.inspectNodeDesc,
      onRun: onInspectWorker,
    },
  ];

  return (
    <Modal open={open} wide={tab === 'tutorial'} title={q.title} onClose={onClose}>
      <div className="quick-start">
        {startTourButton && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/35 bg-[var(--accent-soft)] p-3.5">
            <p className="m-0 text-[13px] font-medium text-text-strong">{messages.tour.startTourBanner}</p>
            {startTourButton}
          </div>
        )}
        <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">{q.subtitle}</p>

        <div
          className="inline-flex flex-wrap self-start rounded-xl border border-border bg-muted/85 p-1"
          role="tablist"
          aria-label={q.tablistAria}
        >
          <button
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer',
              tab === 'quickstart'
                ? 'bg-card text-text-strong shadow-xs'
                : 'text-muted-foreground hover:text-text-strong',
            )}
            type="button"
            role="tab"
            aria-selected={tab === 'quickstart'}
            onClick={() => setTab('quickstart')}
          >
            {q.tabQuickStart}
          </button>
          <button
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer',
              tab === 'legend'
                ? 'bg-card text-text-strong shadow-xs'
                : 'text-muted-foreground hover:text-text-strong',
            )}
            type="button"
            role="tab"
            aria-selected={tab === 'legend'}
            onClick={() => setTab('legend')}
          >
            {q.tabLegend}
          </button>
          <button
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer',
              tab === 'tutorial'
                ? 'bg-card text-text-strong shadow-xs'
                : 'text-muted-foreground hover:text-text-strong',
            )}
            type="button"
            role="tab"
            aria-selected={tab === 'tutorial'}
            onClick={() => setTab('tutorial')}
          >
            {q.tabTutorial}
          </button>
        </div>

        {tab === 'quickstart' ? (
          <div className="grid gap-2.5">
            {steps.map(({ id, num, title, desc, onRun }) => {
              const done = completedSteps.has(id);
              return (
                <button
                  key={id}
                  className="quick-start__step rounded-xl border border-border bg-muted/40 p-3.5 text-start transition-all hover:border-primary/45 hover:bg-muted/80 hover:shadow-xs cursor-pointer"
                  type="button"
                  onClick={onRun}
                >
                  <span
                    className={cn(
                      'inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold',
                      done
                        ? 'bg-[var(--emerald-soft)] text-[var(--emerald)]'
                        : 'bg-[var(--accent-soft)] text-primary',
                    )}
                  >
                    {done ? <Check size={14} aria-hidden="true" /> : num}
                  </span>
                  <span className="grid gap-0.5 min-w-0">
                    <span className="text-[13.5px] font-semibold text-text-strong">{title}</span>
                    <span className="text-xs leading-relaxed text-muted-foreground">{desc}</span>
                  </span>
                  <ArrowRight className="quick-start__arrow text-muted-foreground transition-transform" size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : tab === 'legend' ? (
          <div className="quick-start__legend-grid">
            <div className="grid content-start gap-2.5">
              <h3 className="m-0 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {q.legendTiersTitle}
              </h3>
              <ul className="m-0 grid gap-2 p-0 list-none">
                {q.legendTiers.map((tier) => (
                  <li key={tier.key} className="grid gap-0.5 rounded-xl border border-border bg-muted/40 p-2.5">
                    <span className="flex items-center gap-2 text-xs font-semibold text-text-strong">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ background: TIER_COLORS[tier.key as TierKey] ?? 'var(--primary)' }}
                        aria-hidden="true"
                      />
                      <span>{tier.name}</span>
                    </span>
                    <span className="text-[11.5px] leading-snug text-muted-foreground">{tier.desc}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid content-start gap-2.5">
              <h3 className="m-0 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {q.legendEdgesTitle}
              </h3>
              <ul className="m-0 grid gap-2 p-0 list-none">
                {q.legendEdges.map((edge) => (
                  <li key={edge.tone} className="grid gap-0.5 rounded-xl border border-border bg-muted/40 p-2.5">
                    <span className="flex items-center gap-2 text-xs font-semibold text-text-strong">
                      <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden="true">
                        <line
                          x1="2"
                          y1="5"
                          x2="24"
                          y2="5"
                          stroke={EDGE_SAMPLE_COLOR[edge.tone]}
                          strokeWidth="2.5"
                          strokeDasharray={edge.tone === 'retry' ? '4 3' : undefined}
                        />
                        <circle cx="24" cy="5" r="3" fill={EDGE_SAMPLE_COLOR[edge.tone]} />
                      </svg>
                      <span>{edge.name}</span>
                    </span>
                    <span className="text-[11.5px] leading-snug text-muted-foreground">{edge.desc}</span>
                  </li>
                ))}
              </ul>

              <h3 className="m-0 mt-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {q.shortcutsTitle}
              </h3>
              <div className="grid gap-1.5">
                {q.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.keys}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
                  >
                    <kbd className="rounded border border-border-strong bg-card px-1.5 py-0.5 font-mono text-[11px] text-text-strong whitespace-nowrap shadow-xs">
                      {shortcut.keys}
                    </kbd>
                    <span className="text-muted-foreground">{shortcut.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="quick-start__tutorial-grid">
            {q.tutorialChapters.map((chapter, index) => {
              const Diagram = TUTORIAL_DIAGRAMS[index];
              return (
                <section key={chapter.title} className="quick-start__tutorial-card">
                  <h3 className="m-0 text-sm font-semibold text-text-strong">{chapter.title}</h3>
                  <p className="m-0 text-xs leading-relaxed text-muted-foreground">{chapter.summary}</p>
                  {Diagram && <Diagram />}
                  <ul className="quick-start__tutorial-points">
                    {chapter.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {startTourButton && <div>{startTourButton}</div>}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3.5">
          <label className="quick-start__dismiss inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(event) => onDontShowAgainChange(event.currentTarget.checked)}
            />
            <span>{q.dontShowAgain}</span>
          </label>
          <Button variant="default" size="default" onClick={onClose}>
            {q.getStarted}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
