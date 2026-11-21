import { useId, useState, type FormEvent } from 'react';
import type { RightInspectorProps } from '../types';
import { Modal } from '../ui/Modal';

const rfcSources = [
  { value: 'markdown', label: 'RFC markdown' },
  { value: 'path', label: 'Repo path' },
] as const;

type StartRunModalProps = Pick<RightInspectorProps, 'client' | 'onToast'> & {
  onClose(): void;
  onStarted(): void;
};

type StartPayload = Parameters<RightInspectorProps['client']['startRun']>[0];
type StartError = { field: 'rfc' | 'overrides'; message: string };

function parseOverrides(text: string): StartPayload['model_overrides'] {
  if (!text.trim()) return undefined;
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' || value === null || Array.isArray(value)
    || !Object.values(value).every((model: unknown) => typeof model === 'string')
  ) {
    throw new Error('Model overrides must map role names to model strings.');
  }
  return value as Record<string, string>;
}

export function StartRunModal({ client, onToast, onClose, onStarted }: StartRunModalProps) {
  const [source, setSource] = useState<typeof rfcSources[number]['value']>('markdown');
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
      setError({ field: 'rfc', message: 'Enter RFC markdown.' });
      return;
    }
    const repoPath = path.trim();
    if (source === 'path' && (!repoPath || /^[\\/]|^[a-z]:/i.test(repoPath))) {
      setError({ field: 'rfc', message: 'Enter a path relative to the repository.' });
      return;
    }

    let modelOverrides: StartPayload['model_overrides'];
    try {
      modelOverrides = parseOverrides(overrides);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError({
        field: 'overrides',
        message: error instanceof SyntaxError ? 'Enter valid JSON for model overrides.' : message,
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
      onToast(`Run ${run_id} started (pid ${daemon_pid})`, 'ok');
      onClose();
      onStarted();
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open title="Start Real Run" onClose={() => { if (!submitting) onClose(); }}>
      <form className="right-inspector__section" onSubmit={(event) => void startRun(event)}>
        <fieldset className="right-inspector__section right-inspector__sources" disabled={submitting}>
          <legend>RFC source</legend>
          <div className="right-inspector__actions">
            {rfcSources.map(({ value, label }) => (
              <label key={value}>
                <input type="radio" name="rfc-source" value={value} checked={source === value} onChange={() => {
                  setSource(value);
                  if (rfcError) setError(null);
                }} /> {label}
              </label>
            ))}
          </div>
          {source === 'markdown' ? (
            <textarea
              className="input right-inspector__mono"
              aria-label="RFC markdown"
              aria-invalid={Boolean(rfcError)}
              aria-describedby={rfcError ? `${id}-rfc-error` : undefined}
              rows={7}
              value={markdown}
              onChange={(event) => setMarkdown(event.currentTarget.value)}
            />
          ) : (
            <input
              className="input"
              type="text"
              aria-label="Repo path"
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
          <span>Mode</span>
          <select
            className="select"
            value={mode}
            disabled={submitting}
            onChange={(event) => setMode(event.currentTarget.value === 'interactive' ? 'interactive' : 'overnight')}
          >
            <option value="overnight">overnight</option>
            <option value="interactive">interactive</option>
          </select>
        </label>
        <label className="right-inspector__field">
          <span>Model overrides JSON (optional)</span>
          <textarea
            className="input right-inspector__mono"
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
        <div className="right-inspector__actions right-inspector__actions--end">
          <button className="btn" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn--primary" type="submit" disabled={submitting}>
            {submitting ? 'Starting…' : 'Start Run'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
