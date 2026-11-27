import { useId } from 'react';
import { MESSAGES } from '../../i18n/messages';
import { useGuidedDecisionContent, type GuidedDecisionModalProps } from './GuidedDecisionModal';
import './GuidedDecisionDrawer.css';

export type GuidedDecisionDrawerProps = GuidedDecisionModalProps;

/** Non-modal human gate; its parent controls the open state and run lifecycle. */
export function GuidedDecisionDrawer(props: GuidedDecisionDrawerProps) {
  const titleId = useId();
  const content = useGuidedDecisionContent(props);
  if (!props.open) return null;
  return (
    <aside className="guided-decision-drawer" aria-labelledby={titleId}>
      <h2 id={titleId} className="guided-decision-drawer__title">{MESSAGES[props.locale].guided.decision.title}</h2>
      {content}
    </aside>
  );
}
