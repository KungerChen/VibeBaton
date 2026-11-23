import { TriangleAlert, Upload } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { detectTransferInput } from '../../engine/caseReplay';
import { useI18n } from '../../i18n';
import type { BatonCaseBundle, WorkflowGraph } from '../../types/graph';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Label, Textarea } from '../ui/input';
import { Modal } from '../ui/Modal';
import { buildImportPreview } from './importPreview';

export interface ImportTransferModalProps {
  open: boolean;
  onClose(): void;
  onApplyRecipe(graph: WorkflowGraph): void;
  onLoadCase(bundle: BatonCaseBundle): void;
  canvasDirty: boolean;
}

export function ImportTransferModal({ open, ...props }: ImportTransferModalProps) {
  return open ? <ImportTransferDialog {...props} /> : null;
}

function ImportTransferDialog({
  onClose,
  onApplyRecipe,
  onLoadCase,
  canvasDirty,
}: Omit<ImportTransferModalProps, 'open'>) {
  const { locale, messages } = useI18n();
  const copy = messages.transfer.importModal;
  const fileInput = useRef<HTMLInputElement>(null);
  const latestInput = useRef(0);
  const pasteId = useId();
  const [pasteText, setPasteText] = useState('');
  const [result, setResult] = useState<ReturnType<typeof detectTransferInput> | null>(null);
  const preview = useMemo(() => buildImportPreview(result, locale, canvasDirty), [result, locale, canvasDirty]);
  const isCase = preview.typeBadge === 'case';

  async function readFile(file: File | undefined) {
    if (!file) return;
    const inputId = ++latestInput.current;
    setPasteText('');
    setResult(null);
    try {
      const text = await file.text();
      if (inputId === latestInput.current) setResult(detectTransferInput(text));
    } catch {
      if (inputId === latestInput.current) setResult({ kind: 'invalid', errors: [] });
    }
  }

  function updatePaste(text: string) {
    latestInput.current += 1;
    setPasteText(text);
    setResult(text.trim() ? detectTransferInput(text) : null);
  }

  function confirmImport() {
    if (result?.kind === 'recipe') onApplyRecipe(result.graph);
    else if (result?.kind === 'case') onLoadCase(result.bundle);
    else return;
    onClose();
  }

  return (
    <Modal open title={copy.title} onClose={onClose}>
      <div className="transfer-import-body">
        <input
          ref={fileInput}
          type="file"
          accept=".json,.baton.json,.baton-case.json"
          hidden
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            input.value = '';
            void readFile(file);
          }}
        />
        <Button
          className="transfer-import-drop"
          onClick={() => fileInput.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            event.preventDefault();
            void readFile(event.dataTransfer.files[0]);
          }}
        >
          <Upload size={18} aria-hidden="true" />
          {copy.dropHint}
        </Button>

        <div>
          <div className="transfer-import-paste">
            <Label htmlFor={pasteId}>{copy.pasteLabel}</Label>
            <Textarea
              className="transfer-import-textarea"
              id={pasteId}
              rows={4}
              value={pasteText}
              spellCheck={false}
              aria-invalid={Boolean(pasteText.trim()) && result?.kind === 'invalid'}
              onChange={(event) => updatePaste(event.currentTarget.value)}
            />
          </div>
          <div aria-live="polite">
            {result && (
              <div className="transfer-import-preview">
                <div className="transfer-import-badges">
                  {preview.validationOk && (
                    <Badge variant="info">{isCase ? copy.detectCase : copy.detectRecipe}</Badge>
                  )}
                  <Badge variant={preview.validationOk ? 'success' : 'destructive'}>
                    {preview.validationOk ? copy.validationOk : copy.validationFail}
                  </Badge>
                  {preview.redactionClean !== undefined && (
                    <Badge variant={preview.redactionClean ? 'success' : 'warning'}>
                      {preview.redactionClean ? copy.redactionClean : copy.redactionWarn}
                    </Badge>
                  )}
                </div>
                {preview.validationOk ? (
                  <>
                    <h3 className="transfer-import-name">{preview.name}</h3>
                    <dl className="transfer-import-metrics">
                      <div><dt>{copy.nodes}</dt><dd>{preview.nodeCount}</dd></div>
                      <div><dt>{copy.edges}</dt><dd>{preview.edgeCount}</dd></div>
                      {isCase && (
                        <>
                          <div><dt>{copy.duration}</dt><dd>{preview.durationLabel}</dd></div>
                          <div><dt>{copy.tasks}</dt><dd>{preview.taskSummary}</dd></div>
                        </>
                      )}
                    </dl>
                  </>
                ) : (
                  <p className="transfer-import-error">{copy.invalid}</p>
                )}
                {preview.validationErrors.length > 0 && (
                  <ul className="transfer-import-errors">
                    {preview.validationErrors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}
                  </ul>
                )}
                {preview.warnings.length > 0 && (
                  <ul className="transfer-import-warnings">
                    {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="transfer-import-footer">
          {preview.overwriteWarningKey && (
            <p className="transfer-import-overwrite">
              <TriangleAlert size={16} aria-hidden="true" />
              {copy.overwriteWarning}
            </p>
          )}
          <Button variant="default" disabled={!preview.validationOk} onClick={confirmImport}>
            {isCase ? copy.loadCase : copy.applyRecipe}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
