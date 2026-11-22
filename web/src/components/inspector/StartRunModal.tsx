import { useId, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import type { RightInspectorProps } from '../types';
import { Button } from '../ui/button';
import { Input, Label, Select, Textarea } from '../ui/input';
import { Modal } from '../ui/Modal';

type StartRunModalProps = Pick<RightInspectorProps, 'client' | 'onToast'> & {
  onClose(): void;
  onStarted(): void;
};

type StartPayload = Parameters<RightInspectorProps['client']['startRun']>[0];
type StartError = { field: 'rfc' | 'overrides'; message: string };

function parseOverrides(text: string, errorMsg: string): StartPayload['model_overrides'] {
  if (!text.trim()) return undefined;
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' || value === null || Array.isArray(value)
    || !Object.values(value).every((model: unknown) => typeof model === 'string')
  ) {
    throw new Error(errorMsg);
  }
  return value as Record<string, string>;
}

export function StartRunModal({ client, onToast, onClose, onStarted }: StartRunModalProps) {
  const { messages } = useI18n();
  const rfcSources = [
    { value: 'markdown' as const, label: messages.inspector.rfcMarkdownOption },
    { value: 'path' as const, label: messages.inspector.rfcRepoPathOption },
  ];
  const [source, setSource] = useState<'markdown' | 'path'>('markdown');
  const [markdown, setMarkdown] = useState('');
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<NonNullable<StartPayload['mode']>>('overnight');
  const [overrides, setOverrides] = useState('');
  const [error, setError] = useState<StartError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const id = useId();
  const rfcError = error?.field === 'rfc' ? error.message : undefined;
  const overridesError = error?.field === 'overrides' ? error.message : undefined;

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (source === 'markdown' && !markdown.trim()) {
      setError({ field: 'rfc', message: messages.inspector.errors.enterRfcMarkdown });
      return;
    }
    const repoPath = path.trim();
    if (source === 'path' && (!repoPath || /^[\\/]|^[a-z]:/i.test(repoPath))) {
      setError({ field: 'rfc', message: messages.inspector.errors.enterRelativePath });
      return;
    }

    let modelOverrides: StartPayload['model_overrides'];
    try {
      modelOverrides = parseOverrides(overrides, messages.inspector.errors.overridesMustMapStrings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError({
        field: 'overrides',
        message: error instanceof SyntaxError ? messages.inspector.errors.invalidOverridesJson : message,
      });
      return;
    }

    setSubmitting(true);
    try {
      const { run_id, daemon_pid } = await client.startRun({
        ...(source === 'markdown' ? { rfc_markdown: markdown } : { rfc_path: repoPath }),
        mode,
        ...(modelOverrides === undefined ? {} : { model_overrides: modelOverrides }),
      });
      onToast(messages.toasts.runStarted(run_id, daemon_pid), 'ok');
      onClose();
      onStarted();
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={messages.inspector.modalStartTitle} onClose={() => { if (!submitting) onClose(); }}>
      <form className="right-inspector__section" onSubmit={(event) => void startRun(event)}>
        <fieldset className="right-inspector__section right-inspector__sources" disabled={submitting}>
          <legend className="px-1 text-xs font-semibold text-muted-foreground">
            {messages.inspector.rfcSourceLegend}
          </legend>
          <div className="flex flex-wrap items-center gap-4 text-xs font-medium text-text-strong">
            {rfcSources.map(({ value, label }) => (
              <label key={value} className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="rfc-source"
                  value={value}
                  checked={source === value}
                  onChange={() => {
                    setSource(value);
                    if (rfcError) setError(null);
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {source === 'markdown' ? (
            <Textarea
              className="right-inspector__mono"
              aria-label={messages.inspector.rfcMarkdownAria}
              aria-invalid={Boolean(rfcError)}
              aria-describedby={rfcError ? `${id}-rfc-error` : undefined}
              rows={7}
              value={markdown}
              onChange={(event) => setMarkdown(event.currentTarget.value)}
            />
          ) : (
            <Input
              type="text"
              aria-label={messages.inspector.rfcRepoPathAria}
              aria-invalid={Boolean(rfcError)}
              aria-describedby={rfcError ? `${id}-rfc-error` : undefined}
              placeholder=".baton/00_RFC.md"
              value={path}
              onChange={(event) => setPath(event.currentTarget.value)}
            />
          )}
          {rfcError && <p className="right-inspector__error" id={`${id}-rfc-error`} role="alert">{rfcError}</p>}
        </fieldset>

        <label className="right-inspector__field">
          <Label className="pointer-events-none">{messages.inspector.runModeLabel}</Label>
          <Select
            value={mode}
            disabled={submitting}
            onChange={(event) => setMode(event.currentTarget.value === 'interactive' ? 'interactive' : 'overnight')}
          >
            <option value="overnight">{messages.inspector.runModes.overnight}</option>
            <option value="interactive">{messages.inspector.runModes.interactive}</option>
          </Select>
        </label>

        <label className="right-inspector__field">
          <Label className="pointer-events-none">{messages.inspector.modelOverridesLabel}</Label>
          <Textarea
            className="right-inspector__mono"
            aria-invalid={Boolean(overridesError)}
            aria-describedby={overridesError ? `${id}-overrides-error` : undefined}
            rows={3}
            value={overrides}
            disabled={submitting}
            onChange={(event) => setOverrides(event.currentTarget.value)}
          />
        </label>
        {overridesError && (
          <p className="right-inspector__error" id={`${id}-overrides-error`} role="alert">{overridesError}</p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {messages.inspector.cancel}
          </Button>
          <Button variant="default" type="submit" disabled={submitting}>
            {submitting ? messages.inspector.startingRun : messages.inspector.startRun}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
