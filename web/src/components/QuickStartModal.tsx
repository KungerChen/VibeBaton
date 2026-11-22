import './QuickStartModal.css';
import { ArrowRight, Check } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { TIER_COLORS } from './nodes/BatonNode';
import type { TierKey } from '../types/graph';
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
}

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
}: QuickStartModalProps) {
  const { messages } = useI18n();
  const [tab, setTab] = useState<'quickstart' | 'legend'>('quickstart');
  const q = messages.quickStart;

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
    <Modal open={open} title={q.title} onClose={onClose}>
      <div className="quick-start">
        <p className="quick-start__subtitle">{q.subtitle}</p>

        <div className="quick-start__tabs" role="tablist" aria-label={q.tablistAria}>
          <button
            className={`quick-start__tab${tab === 'quickstart' ? ' quick-start__tab--active' : ''}`}
            type="button"
            role="tab"
            aria-selected={tab === 'quickstart'}
            onClick={() => setTab('quickstart')}
          >
            {q.tabQuickStart}
          </button>
          <button
            className={`quick-start__tab${tab === 'legend' ? ' quick-start__tab--active' : ''}`}
            type="button"
            role="tab"
            aria-selected={tab === 'legend'}
            onClick={() => setTab('legend')}
          >
            {q.tabLegend}
          </button>
        </div>

        {tab === 'quickstart' ? (
          <div className="quick-start__steps">
            {steps.map(({ id, num, title, desc, onRun }) => {
              const done = completedSteps.has(id);
              return (
                <button key={id} className="quick-start__step" type="button" onClick={onRun}>
                  <span className={`quick-start__num${done ? ' quick-start__num--done' : ''}`}>
                    {done ? <Check size={14} aria-hidden="true" /> : num}
                  </span>
                  <span className="quick-start__step-body">
                    <span className="quick-start__step-title">{title}</span>
                    <span className="quick-start__step-desc">{desc}</span>
                  </span>
                  <ArrowRight className="quick-start__arrow" size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="quick-start__legend-grid">
            <div className="quick-start__legend-col">
              <h3 className="quick-start__section-title">{q.legendTiersTitle}</h3>
              <ul className="quick-start__legend-list">
                {q.legendTiers.map((tier) => (
                  <li key={tier.key} className="quick-start__legend-item">
                    <span className="quick-start__legend-head">
                      <span
                        className="quick-start__swatch"
                        style={{ background: TIER_COLORS[tier.key as TierKey] ?? 'var(--accent)' }}
                        aria-hidden="true"
                      />
                      <span>{tier.name}</span>
                    </span>
                    <span className="quick-start__legend-desc">{tier.desc}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="quick-start__legend-col">
              <h3 className="quick-start__section-title">{q.legendEdgesTitle}</h3>
              <ul className="quick-start__legend-list">
                {q.legendEdges.map((edge) => (
                  <li key={edge.tone} className="quick-start__legend-item">
                    <span className="quick-start__legend-head">
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
                    <span className="quick-start__legend-desc">{edge.desc}</span>
                  </li>
                ))}
              </ul>

              <h3 className="quick-start__section-title">{q.shortcutsTitle}</h3>
              <div className="quick-start__shortcuts">
                {q.shortcuts.map((shortcut) => (
                  <div key={shortcut.keys} className="quick-start__shortcut-row">
                    <kbd className="quick-start__kbd">{shortcut.keys}</kbd>
                    <span>{shortcut.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="quick-start__footer">
          <label className="quick-start__dismiss">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(event) => onDontShowAgainChange(event.currentTarget.checked)}
            />
            <span>{q.dontShowAgain}</span>
          </label>
          <button className="btn btn--primary" type="button" onClick={onClose}>
            {q.getStarted}
          </button>
        </div>
      </div>
    </Modal>
  );
}
