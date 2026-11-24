import { Check } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BatonApiClient } from '../../api/client';
import { useI18n } from '../../i18n';
import type { BatonCaseBundle } from '../../types/graph';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input, Label } from '../ui/input';
import { Modal } from '../ui/Modal';
import { Switch } from '../ui/switch';
import { caseFileName, checklistRows, serializeCase } from './exportCase';

export interface ExportCaseModalProps {
  open: boolean;
  onClose(): void;
  client: BatonApiClient;
  runId: string | null;
  defaultTitle: string;
  onPreviewInPlayer(bundle: BatonCaseBundle): void;
  onToast?(msg: string): void;
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

export function ExportCaseModal({ open, ...props }: ExportCaseModalProps) {
  return open ? <ExportCaseDialog key={props.runId ?? undefined} {...props} /> : null;
}

function ExportCaseDialog({
  client, runId, defaultTitle, onClose, onPreviewInPlayer, onToast,
}: Omit<ExportCaseModalProps, 'open'>) {
  const { locale, messages } = useI18n();
  const copy = messages.transfer.exportCaseModal;
  const id = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [includeReviews, setIncludeReviews] = useState(true);
  const [anonymize, setAnonymize] = useState(false);

  const request = useMemo(
    () => runId === null ? null : { client, runId, options: { title, includeReviews, anonymize } },
    [client, runId, title, includeReviews, anonymize],
  );
  type Request = NonNullable<typeof request>;
  const [result, setResult] = useState<
    { request: Request; status: 'ready'; bundle: BatonCaseBundle }
    | { request: Request; status: 'error' }
    | null
  >(null);

  // Keep actions tied to the current options, including during the debounce interval.
  const current = result?.request === request ? result : null;
  const status = current?.status ?? (request ? 'loading' : 'idle');
  const bundle = current?.status === 'ready' ? current.bundle : null;

  useEffect(() => {
    if (!request) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const next = await request.client.exportRunCase(request.runId, request.options);
        if (active) setResult({ request, status: 'ready', bundle: next });
      } catch {
        if (active) setResult({ request, status: 'error' });
      }
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [request]);

  const checklist = bundle ? checklistRows(bundle.redaction_report, locale) : null;
  const cleanBundle = checklist?.verifiedClean ? bundle : null;

  function download() {
    if (!cleanBundle) return;
    const blob = new Blob([serializeCase(cleanBundle)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = caseFileName(cleanBundle);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  useEffect(() => () => {
    if (copyTimerRef.current !== undefined) globalThis.clearTimeout(copyTimerRef.current);
  }, []);

  async function copyJson() {
    if (!cleanBundle) return;
    const text = serializeCase(cleanBundle);
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      // Fall back to selection copy inside the modal.
    }
    if (!ok && contentRef.current) {
      ok = copyWithSelection(text, contentRef.current);
    }
    if (!ok) {
      onToast?.(`${copy.copyJson} ✕`);
      return;
    }
    setCopied(true);
    if (copyTimerRef.current !== undefined) globalThis.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = globalThis.setTimeout(() => setCopied(false), 2000);
    onToast?.(`${copy.copyJson} ✓`);
  }

  function preview() {
    if (!cleanBundle) return;
    onPreviewInPlayer(cleanBundle);
    onClose();
  }

  return (
    <Modal open title={copy.title} onClose={onClose}>
      <div className="transfer-export-case-body" ref={contentRef}>
        <div className="transfer-export-case-field">
          <Label htmlFor={`${id}-title`}>{copy.titleLabel}</Label>
          <Input
            id={`${id}-title`}
            value={title}
            disabled={runId === null}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </div>

        <div className="transfer-export-case-options">
          <div className="transfer-export-case-option">
            <Label htmlFor={`${id}-reviews`}>{copy.includeReviews}</Label>
            <Switch
              id={`${id}-reviews`}
              checked={includeReviews}
              disabled={runId === null}
              onCheckedChange={setIncludeReviews}
            />
          </div>
          <div className="transfer-export-case-option">
            <Label htmlFor={`${id}-anonymize`}>{copy.anonymize}</Label>
            <Switch
              id={`${id}-anonymize`}
              checked={anonymize}
              disabled={runId === null}
              onCheckedChange={setAnonymize}
            />
          </div>
        </div>

        <section className="transfer-export-case-checklist" aria-labelledby={`${id}-checklist`}>
          <div className="transfer-export-case-checklist-header">
            <h3 id={`${id}-checklist`} className="transfer-export-case-checklist-title">{copy.checklistTitle}</h3>
            {checklist && (
              <Badge variant={checklist.verifiedClean ? 'success' : 'destructive'} role="status">
                {checklist.verifiedClean ? copy.verifiedClean : copy.notClean}
              </Badge>
            )}
          </div>
          {status === 'loading' && <p className="transfer-export-case-status" role="status">{copy.loading}</p>}
          {(status === 'error' || status === 'idle') && (
            <p className="transfer-export-case-error" role="alert">{copy.error}</p>
          )}
          {checklist && (
            <ul className="transfer-export-case-counts" role="list">
              {checklist.rows.map(({ key, label, count }) => (
                <li className="transfer-export-case-count" key={key}>
                  <span>{label}</span>
                  <strong>{count.toLocaleString(locale)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="transfer-export-case-actions">
          <Button className="transfer-export-case-action" variant="default" disabled={!cleanBundle} onClick={download}>
            {copy.download}
          </Button>
          <Button
            className="transfer-export-case-action"
            aria-live="polite"
            disabled={!cleanBundle}
            onClick={() => void copyJson()}
          >
            {copied ? (
              <>
                <Check size={14} aria-hidden="true" />
                <span>{copy.copied}</span>
              </>
            ) : copy.copyJson}
          </Button>
          <Button className="transfer-export-case-action" disabled={!cleanBundle} onClick={preview}>
            {copy.previewReplay}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
