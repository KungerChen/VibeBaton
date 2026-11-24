import './GuidedDecisionModal.css';
import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { BatonApiClient, type RunDecision } from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { Button } from '../ui/button';
import { Label, Textarea } from '../ui/input';
import { Modal } from '../ui/Modal';
import { GlossaryTerm, useGlossaryHighlights } from './GlossaryTerm';

export interface GuidedDecisionOption {
  /** Only choices the backend /resolve endpoint accepts. */
  id: RunDecision;
  label_en: string;
  label_zh: string;
  hint_en: string;
  hint_zh: string;
}

export interface GuidedResolvePayload {
  runId: string;
  taskId: string;
  choice: RunDecision;
  note: string;
}

export type GuidedDecisionResolver = (payload: GuidedResolvePayload) => Promise<unknown>;

export interface GuidedDecisionModalProps {
  open: boolean;
  runId: string;
  taskId: string;
  question: string;
  options: GuidedDecisionOption[];
  onResolved(): void;
  locale: Locale;
  resolver?: GuidedDecisionResolver;
}

const DEFAULT_OPTIONS: readonly GuidedDecisionOption[] = [
  {
    id: 'approve',
    label_en: 'Approve',
    label_zh: '批准',
    hint_en: 'Continue and apply this task.',
    hint_zh: '继续并采用这项任务。',
  },
  {
    id: 'reject',
    label_en: 'Reject',
    label_zh: '拒绝',
    hint_en: 'Stop without applying this task.',
    hint_zh: '停止并放弃这项任务。',
  },
];

function isRunDecision(value: string): value is RunDecision {
  return value === 'approve' || value === 'reject';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOption(value: unknown): GuidedDecisionOption | null {
  if (!isRecord(value)) return null;
  const id = readText(value.id);
  // Drop choices POST /api/runs/<id>/resolve would refuse with HTTP 400.
  if (!isRunDecision(id)) return null;
  const labelEn = readText(value.label_en);
  const hintEn = readText(value.hint_en);
  return {
    id,
    label_en: labelEn || id,
    label_zh: readText(value.label_zh) || labelEn || id,
    hint_en: hintEn,
    hint_zh: readText(value.hint_zh) || hintEn,
  };
}

function readOptions(value: unknown): GuidedDecisionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = normalizeOption(entry);
    return option ? [option] : [];
  });
}

function defaultOptions(): GuidedDecisionOption[] {
  return DEFAULT_OPTIONS.map((option) => ({ ...option }));
}

/**
 * Live WAITING_HUMAN events may carry choices in the event row itself or in its decoded
 * `payload` / raw `payload_json`. Only approve/reject are kept; events without usable choices fall back to those defaults.
 */
export function optionsFromEvent(event: unknown): GuidedDecisionOption[] {
  const row = parseRecord(event);
  if (!row) return defaultOptions();

  const direct = readOptions(row.options);
  if (direct.length > 0) return direct;

  for (const key of ['payload', 'payload_json'] as const) {
    const payload = parseRecord(row[key]);
    const options = readOptions(payload?.options);
    if (options.length > 0) return options;
  }

  return defaultOptions();
}

export function buildResolvePayload(
  runId: string,
  taskId: string,
  choice: RunDecision,
  note = '',
): GuidedResolvePayload {
  return { runId, taskId, choice, note: note.trim() };
}

// client.ts exposes resolveRunTask on BatonApiClient; callers may inject a resolver bound to
// the app's own client, while this lazily initialized fallback keeps the default working.
let fallbackClient: BatonApiClient | null = null;
let fallbackReady: Promise<unknown> | null = null;

async function defaultResolver(payload: GuidedResolvePayload): Promise<unknown> {
  const client = fallbackClient ?? (fallbackClient = new BatonApiClient());
  fallbackReady ??= client.init();
  await fallbackReady;
  return client.resolveRunTask(payload.runId, {
    taskId: payload.taskId,
    choice: payload.choice,
    note: payload.note,
  });
}

function ignoreClose(): void {
  // A human gate can only be left through onResolved, after the decision succeeds.
}

export function GuidedDecisionModal({
  open,
  runId,
  taskId,
  question,
  options,
  onResolved,
  locale,
  resolver = defaultResolver,
}: GuidedDecisionModalProps) {
  const copy = MESSAGES[locale].guided.decision;
  const questionId = useId();
  const noteId = useId();
  const groupName = useId();
  const questionSegments = useGlossaryHighlights(question, locale);
  const [choice, setChoice] = useState<RunDecision | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const visibleOptions = options.length > 0 ? options : defaultOptions();
  const canSubmit = visibleOptions.some((option) => option.id === choice);

  useEffect(() => {
    if (!open) return;
    setChoice(null);
    setNote('');
    setError(undefined);
    setSubmitting(false);
    submittingRef.current = false;
  }, [open, runId, taskId]);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || !canSubmit || !choice) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await resolver(buildResolvePayload(runId, taskId, choice, note));
      onResolved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} title={copy.title} onClose={ignoreClose}>
      <div className="guided-decision">
        <p className="guided-decision__intro">{copy.intro}</p>
        <p className="guided-decision__question" id={questionId}>
          {questionSegments.map((segment, index) => (
            <Fragment key={`${segment.termId ?? 'text'}-${index}`}>
              {segment.termId ? <GlossaryTerm termId={segment.termId}>{segment.text}</GlossaryTerm> : segment.text}
            </Fragment>
          ))}
        </p>

        <div className="guided-decision__options" role="radiogroup" aria-labelledby={questionId}>
          {visibleOptions.map((option) => {
            const label = (locale === 'zh'
              ? option.label_zh || option.label_en
              : option.label_en || option.label_zh) || option.id;
            const hint = locale === 'zh'
              ? option.hint_zh || option.hint_en
              : option.hint_en || option.hint_zh;
            return (
              <label
                key={option.id}
                className={`guided-decision__option${choice === option.id ? ' guided-decision__option--selected' : ''}`}
              >
                <input
                  type="radio"
                  className="guided-decision__radio"
                  name={groupName}
                  value={option.id}
                  checked={choice === option.id}
                  disabled={submitting}
                  onChange={() => {
                    setChoice(option.id);
                    setError(undefined);
                  }}
                />
                <span className="guided-decision__option-body">
                  <span className="guided-decision__option-label">{label}</span>
                  {hint ? <span className="guided-decision__option-hint">{hint}</span> : null}
                </span>
              </label>
            );
          })}
        </div>

        <form className="guided-decision__form" aria-busy={submitting} onSubmit={(event) => void submit(event)}>
          <div className="guided-decision__field">
            <Label htmlFor={noteId}>{copy.noteLabel}</Label>
            <Textarea
              id={noteId}
              rows={3}
              value={note}
              disabled={submitting}
              onChange={(event) => {
                setNote(event.currentTarget.value);
                setError(undefined);
              }}
            />
          </div>
          {error ? <p className="guided-decision__error" role="alert">{error}</p> : null}
          <div className="guided-decision__actions">
            <Button type="submit" variant="default" disabled={!canSubmit || submitting}>
              {copy.submit}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
