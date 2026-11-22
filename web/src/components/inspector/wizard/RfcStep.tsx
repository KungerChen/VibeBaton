import { AlertTriangle, Sparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { BatonApiClient } from '../../../api/client';
import { useI18n } from '../../../i18n';
import type { RfcBrainstormRequest, RfcReadinessResult } from '../../../types/graph';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardContent } from '../../ui/card';
import { Input, Label, Textarea } from '../../ui/input';
import { decideRfcSkip } from '../launchWizard';
import { LAUNCH_MESSAGES, translateRfcSection, translateRfcWarning } from './messages';

const CHECK_DELAY_MS = 350;

type CheckedDraft = { markdown: string; readiness: RfcReadinessResult | null };

export function useRfcDraft(client: BatonApiClient, active: boolean) {
  const [markdown, setMarkdown] = useState('');
  const [checked, setChecked] = useState<CheckedDraft>();
  const [operation, setOperation] = useState<'generate' | 'skip'>();
  const [generateError, setGenerateError] = useState(false);
  const [skipWarning, setSkipWarning] = useState<readonly string[]>();
  const currentCheck = checked?.markdown === markdown ? checked : undefined;
  const checking = active && Boolean(markdown.trim()) && !currentCheck;

  useEffect(() => {
    if (!checking || operation) return;
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
  }, [checking, client, markdown, operation]);

  function edit(next: string) {
    setMarkdown(next);
    setChecked(undefined);
    setSkipWarning(undefined);
    setGenerateError(false);
  }

  async function generate(request: RfcBrainstormRequest) {
    setOperation('generate');
    setGenerateError(false);
    setSkipWarning(undefined);
    try {
      const { rfc_markdown, readiness } = await client.brainstormRfc(request);
      setMarkdown(rfc_markdown);
      setChecked({ markdown: rfc_markdown, readiness });
    } catch {
      setGenerateError(true);
    } finally {
      setOperation(undefined);
    }
  }

  async function skip(onAdvance: () => void) {
    setOperation('skip');
    setSkipWarning(undefined);
    try {
      const readiness = await client.checkRfc(markdown);
      setChecked({ markdown, readiness });
      const decision = decideRfcSkip(readiness);
      if (decision.kind === 'confirm') setSkipWarning(decision.missingSections);
      else onAdvance();
    } catch {
      setChecked({ markdown, readiness: null });
    } finally {
      setOperation(undefined);
    }
  }

  return {
    markdown, checking, operation, generateError, skipWarning, edit, generate, skip,
    readiness: currentCheck?.readiness,
    checkError: currentCheck?.readiness === null,
    dismissSkipWarning: () => setSkipWarning(undefined),
  };
}

type RfcStepProps = {
  rfc: ReturnType<typeof useRfcDraft>;
  onConfirmSkip(): void;
};

export function RfcStep({ rfc, onConfirmSkip }: RfcStepProps) {
  const { locale, messages: { inspector, wizard } } = useI18n();
  const copy = LAUNCH_MESSAGES[locale];
  const id = useId();
  const warningHeading = useRef<HTMLHeadingElement>(null);
  const [request, setRequest] = useState({
    goal: '',
    constraints: '',
    acceptance_cmd: '',
    non_goals: '',
  });
  const fields = [
    ['goal', wizard.fields.goal],
    ['constraints', wizard.fields.constraints],
    ['acceptance_cmd', wizard.fields.verificationCommand],
    ['non_goals', wizard.fields.nonGoals],
  ] as const;
  const { readiness, skipWarning } = rfc;

  useEffect(() => {
    if (skipWarning) warningHeading.current?.focus();
  }, [skipWarning]);

  return (
    <div className="grid gap-3">
      <div className="start-run-wizard__rfc-layout">
        <Card>
          <form className="grid gap-3 p-3.5" onSubmit={(event) => {
            event.preventDefault();
            if (!rfc.operation && request.goal.trim()) void rfc.generate(request);
          }}>
            <fieldset className="grid gap-2.5" disabled={Boolean(rfc.operation)}>
              {fields.map(([field, label]) => {
                const Component = field === 'constraints' || field === 'non_goals' ? Textarea : Input;
                return (
                  <div className="start-run-wizard__field" key={field}>
                    <Label htmlFor={`${id}-${field}`}>{label}</Label>
                    <Component
                      id={`${id}-${field}`}
                      className={field === 'acceptance_cmd' ? 'font-mono' : undefined}
                      value={request[field]}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setRequest((previous) => ({ ...previous, [field]: value }));
                      }}
                    />
                  </div>
                );
              })}
            </fieldset>
            <Button type="submit" className="justify-self-start" disabled={Boolean(rfc.operation) || !request.goal.trim()}>
              <Sparkles size={14} aria-hidden="true" />
              {rfc.operation === 'generate' ? copy.generating : wizard.generateRfc}
            </Button>
            {rfc.generateError && <p className="start-run-wizard__error" role="alert">{copy.generateError}</p>}
          </form>
        </Card>
        <Card>
          <CardContent className="grid gap-3 pt-3.5">
            <div className="start-run-wizard__field">
              <Label htmlFor={`${id}-markdown`}>{inspector.rfcMarkdownOption}</Label>
              <Textarea
                id={`${id}-markdown`}
                className="start-run-wizard__markdown font-mono"
                value={rfc.markdown}
                spellCheck={false}
                readOnly={Boolean(rfc.operation)}
                onChange={(event) => rfc.edit(event.currentTarget.value)}
              />
            </div>
            <div className="grid gap-2 empty:hidden" aria-live="polite">
              {(rfc.checking || rfc.operation === 'skip') && (
                <p className="start-run-wizard__note">{copy.checkingRfc}</p>
              )}
              {rfc.checkError && <p className="start-run-wizard__error">{copy.checkError}</p>}
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
          </CardContent>
        </Card>
      </div>
      {skipWarning && (
        <Card className="start-run-wizard__skip-warning">
          <div className="grid gap-2 p-3.5">
            <h3 ref={warningHeading} tabIndex={-1} className="m-0 flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle size={16} aria-hidden="true" />
              {wizard.skipWarning.title}
            </h3>
            <p className="m-0 text-xs leading-relaxed">{wizard.skipWarning.body}</p>
            <ul className="start-run-wizard__warnings">
              {skipWarning.map((section) => <li key={section}>{translateRfcSection(section, locale, wizard)}</li>)}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={rfc.dismissSkipWarning}>{wizard.skipWarning.cancel}</Button>
              <Button size="sm" variant="default" onClick={onConfirmSkip}>{wizard.skipWarning.confirm}</Button>
            </div>
          </div>
        </Card>
      )}
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
      <ul className="start-run-wizard__warnings">
        {warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
    </div>
  );
}
