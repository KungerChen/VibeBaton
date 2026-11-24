import { Check, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { WorkflowGraph } from '../../types/graph';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Modal } from '../ui/Modal';
import { recipeFileName, recipeStats, serializeRecipe } from './exportRecipe';

export interface ExportRecipeModalProps {
  open: boolean;
  onClose(): void;
  graph: WorkflowGraph;
  liveViewActive: boolean;
  onSwitchToCaseExport(): void;
  buildShareUrl(graph: WorkflowGraph): string;
  onToast?(message: string): void;
}

function copyWithSelection(text: string, container: HTMLElement): boolean {
  const previousFocus = document.activeElement;
  const field = document.createElement('textarea');
  field.className = 'transfer-export-recipe-clipboard';
  field.value = text;
  field.readOnly = true;
  container.append(field);

  try {
    field.focus({ preventScroll: true });
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }
}

export function ExportRecipeModal({ open, onClose, ...props }: ExportRecipeModalProps) {
  const { messages } = useI18n();
  return (
    <Modal open={open} title={messages.transfer.exportRecipeModal.title} onClose={onClose}>
      {open && <ExportRecipeContent {...props} />}
    </Modal>
  );
}

type ExportRecipeContentProps = Omit<ExportRecipeModalProps, 'open' | 'onClose'>;

function ExportRecipeContent({ graph, liveViewActive, onSwitchToCaseExport, buildShareUrl, onToast }: ExportRecipeContentProps) {
  const { messages } = useI18n();
  const labels = messages.transfer.exportRecipeModal;
  const contentRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const [copiedKind, setCopiedKind] = useState<'json' | 'link' | null>(null);
  const [feedback, setFeedback] = useState<{
    message: string;
    manualCopy?: { label: string; text: string };
  } | null>(null);
  const { name, nodeCount, edgeCount } = recipeStats(graph);
  const json = serializeRecipe(graph);
  const counts = labels.counts(nodeCount, edgeCount);

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) globalThis.clearTimeout(copyTimerRef.current);
  }, []);

  function download() {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = recipeFileName(graph);
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  async function copy(kind: 'json' | 'link', getText: () => string, label: string) {
    let text: string;
    try {
      text = getText();
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : String(error) });
      return;
    }

    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      // Fall back to a selection inside the dialog when clipboard access is denied.
    }

    const container = contentRef.current;
    if (!copied && container) copied = copyWithSelection(text, container);
    if (copied) {
      setCopiedKind(kind);
      if (copyTimerRef.current !== undefined) globalThis.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = globalThis.setTimeout(() => setCopiedKind(null), 2000);
      setFeedback({ message: labels.copied });
      onToast?.(labels.copied);
    } else {
      setFeedback({
        message: labels.manualCopyHint,
        manualCopy: { label, text },
      });
    }
  }

  return (
    <div className="transfer-export-recipe-content" ref={contentRef}>
      <header className="transfer-export-recipe-summary">
        <h3 className="transfer-export-recipe-name">{name}</h3>
        <p className="transfer-export-recipe-counts">{counts}</p>
        <Badge variant="success" className="transfer-export-recipe-assurance">
          <ShieldCheck size={14} aria-hidden="true" />
          {labels.assurance}
        </Badge>
      </header>

      {liveViewActive && (
        <aside className="transfer-export-recipe-advisory">
          <p className="transfer-export-recipe-advisory-text">{labels.liveAdvisory}</p>
          <Button className="transfer-export-recipe-action" onClick={onSwitchToCaseExport}>
            {labels.switchToCase}
          </Button>
        </aside>
      )}

      <details className="transfer-export-recipe-details">
        <summary className="transfer-export-recipe-toggle">{labels.previewToggle}</summary>
        <pre className="transfer-export-recipe-preview" tabIndex={0} role="region" aria-label={labels.previewToggle}>
          {json}
        </pre>
      </details>

      <footer>
        <div className="transfer-export-recipe-actions">
          <Button className="transfer-export-recipe-action" variant="default" onClick={download}>
            {labels.download}
          </Button>
          <Button
            className="transfer-export-recipe-action"
            aria-live="polite"
            onClick={() => copy('json', () => json, labels.copyJson)}
          >
            {copiedKind === 'json' ? (
              <>
                <Check size={14} aria-hidden="true" />
                <span>{messages.inspector.copiedInline}</span>
              </>
            ) : labels.copyJson}
          </Button>
          <Button
            className="transfer-export-recipe-action"
            aria-live="polite"
            onClick={() => copy('link', () => buildShareUrl(graph), labels.copyLink)}
          >
            {copiedKind === 'link' ? (
              <>
                <Check size={14} aria-hidden="true" />
                <span>{messages.inspector.copiedInline}</span>
              </>
            ) : labels.copyLink}
          </Button>
        </div>
        <div className="transfer-export-recipe-status" role="status">{feedback?.message}</div>
        {feedback?.manualCopy && (
          <textarea
            key={feedback.manualCopy.label}
            className="transfer-export-recipe-manual-copy"
            aria-label={feedback.manualCopy.label}
            value={feedback.manualCopy.text}
            readOnly
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
      </footer>
    </div>
  );
}
