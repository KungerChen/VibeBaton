import './RfcStep.css';
import { useEffect, useId, useState, type DragEvent } from 'react';
import type { BatonApiClient } from '../../../api/client';
import { useI18n } from '../../../i18n';
import type { RfcReadinessResult } from '../../../types/graph';
import { Badge } from '../../ui/badge';
import { Label, Textarea } from '../../ui/input';
import { LAUNCH_MESSAGES, translateRfcSection, translateRfcWarning } from './messages';

const CHECK_DELAY_MS = 350;
/** A pasted RFC is a document, not an archive; larger drops are refused. */
export const MAX_DROPPED_RFC_BYTES = 256 * 1024;
const TEXT_FILE = /\.(?:md|markdown|txt)$/i;

type CheckedDraft = { markdown: string; readiness: RfcReadinessResult | null };

export function useRfcDraft(client: Pick<BatonApiClient, 'checkRfc'>, active: boolean) {
  const [markdown, setMarkdown] = useState('');
  const [checked, setChecked] = useState<CheckedDraft>();
  const currentCheck = checked?.markdown === markdown ? checked : undefined;
  const checking = active && Boolean(markdown.trim()) && !currentCheck;

  useEffect(() => {
    if (!checking) return;
    let current = true;
    const timer = setTimeout(() => {
      void client.checkRfc(markdown).then(
        (readiness) => { if (current) setChecked({ markdown, readiness }); },
        () => { if (current) setChecked({ markdown, readiness: null }); },
      );
    }, CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [checking, client, markdown]);

  function edit(next: string) {
    setMarkdown(next);
    setChecked(undefined);
  }

  return {
    markdown, checking, edit,
    readiness: currentCheck?.readiness,
    checkError: currentCheck?.readiness === null,
  };
}

/** Why a dropped file cannot be read as the RFC text, or null when it can. */
export function droppedFileProblem(file: Pick<File, 'name' | 'type' | 'size'>): 'not_text' | 'too_large' | null {
  if (!file.type.startsWith('text/') && !(file.type === '' && TEXT_FILE.test(file.name))) return 'not_text';
  return file.size > MAX_DROPPED_RFC_BYTES ? 'too_large' : null;
}

type RfcStepProps = {
  rfc: ReturnType<typeof useRfcDraft>;
  /** Every new text: typed, pasted, or read from a dropped text file. */
  onChange(markdown: string): void;
  readOnly?: boolean;
  /** Shown inside the empty box. */
  placeholder?: string;
};

export function RfcStep({ rfc, onChange, readOnly = false, placeholder }: RfcStepProps) {
  const { locale, messages: { guided, inspector, wizard } } = useI18n();
  const copy = LAUNCH_MESSAGES[locale];
  const id = useId();
  const [dropProblem, setDropProblem] = useState<'not_text' | 'too_large' | null>(null);
  const { readiness } = rfc;

  function drop(event: DragEvent<HTMLTextAreaElement>) {
    const file = event.dataTransfer.files[0];
    // Dragged text needs nothing: the browser inserts it into the box as plain text.
    if (!file || readOnly) return;
    event.preventDefault();
    const problem = droppedFileProblem(file);
    setDropProblem(problem);
    if (!problem) void file.text().then(onChange, () => setDropProblem('not_text'));
  }

  return (
    <div className="grid gap-3">
      <div className="rfc-step__field">
        <Label htmlFor={`${id}-markdown`}>{inspector.rfcMarkdownOption}</Label>
        <Textarea
          id={`${id}-markdown`}
          className="rfc-step__markdown font-mono"
          value={rfc.markdown}
          spellCheck={false}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={(event) => {
            setDropProblem(null);
            onChange(event.currentTarget.value);
          }}
          onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
          onDrop={drop}
        />
      </div>
      {dropProblem && (
        <p className="rfc-step__error" role="alert">
          {dropProblem === 'too_large' ? guided.pasteRfc.dropTooLarge : guided.pasteRfc.dropNotText}
        </p>
      )}
      <div className="grid gap-2 empty:hidden" aria-live="polite">
        {rfc.checking && <p className="rfc-step__note">{copy.checkingRfc}</p>}
        {rfc.checkError && <p className="rfc-step__error">{copy.checkError}</p>}
        {readiness && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={readiness.score >= 70 ? 'success' : readiness.score >= 40 ? 'warning' : 'destructive'}>
                {wizard.readinessScore(readiness.score)}
              </Badge>
              <Badge variant={readiness.safe_for_overnight ? 'success' : 'outline'}>
                {readiness.safe_for_overnight ? copy.safeForOvernight : copy.unsafeForOvernight}
              </Badge>
            </div>
            <RfcWarnings readiness={readiness} />
          </>
        )}
      </div>
    </div>
  );
}

function RfcWarnings({ readiness }: { readiness: RfcReadinessResult }) {
  const { locale, messages: { wizard } } = useI18n();
  const warnings = readiness.warnings.map((warning) => translateRfcWarning(warning, wizard.warnings));
  if (readiness.missing_sections.length > 0) {
    const sections = readiness.missing_sections.map((section) => translateRfcSection(section, locale, wizard));
    warnings.unshift(`${wizard.warnings.missingSections} · ${sections.join(locale === 'zh' ? '、' : ', ')}`);
  }
  if (readiness.detected_commands.length === 0) warnings.push(wizard.warnings.missingVerificationCommand);
  if (warnings.length === 0) return null;

  return (
    <div className="text-xs text-muted-foreground">
      <p className="mb-1 mt-0 font-semibold text-foreground">{wizard.warnings.title}</p>
      <ul className="rfc-step__warnings">
        {warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
    </div>
  );
}
