import './StartRunModal.css';
import { ArrowLeft, ArrowRight, Check, Play, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { useI18n } from '../../i18n';
import { formatProviderDisplay, translateRole } from '../../i18n/presets';
import type { RolesConfigResponse } from '../../types/graph';
import type { RightInspectorProps } from '../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Label, Select, Textarea } from '../ui/input';
import { Modal } from '../ui/Modal';
import { decideRfcSkip, getWizardStep, WIZARD_STEPS, type WizardStep } from './launchWizard';
import { LAUNCH_MESSAGES } from './wizard/messages';
import { PreflightStep } from './wizard/PreflightStep';
import { RfcStep, useRfcDraft } from './wizard/RfcStep';

type StartRunModalProps = Pick<RightInspectorProps, 'client' | 'onToast'> & {
  onClose(): void;
  onStarted(runId?: string): void;
};

type StartPayload = Parameters<RightInspectorProps['client']['startRun']>[0];

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
  const { locale, messages: { budgetProfile: budgetCopy, inspector, toasts, wizard } } = useI18n();
  const copy = LAUNCH_MESSAGES[locale];
  const [step, setStep] = useState<WizardStep>('preflight');
  const [rolesConfig, setRolesConfig] = useState<RolesConfigResponse | null>(null);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [mode, setMode] = useState<NonNullable<StartPayload['mode']>>('overnight');
  const [overrides, setOverrides] = useState('');
  const [overridesError, setOverridesError] = useState<string>();
  const [startError, setStartError] = useState<{ kind: 'timeout' | 'error'; detail?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const rfc = useRfcDraft(client, step === 'brainstorm');
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const stepIndex = WIZARD_STEPS.indexOf(step);
  const blankRfc = !rfc.markdown.trim();
  const canAdvanceRfc = !blankRfc && rfc.readiness && decideRfcSkip(rfc.readiness).kind === 'advance';
  const busy = savingCredentials || submitting;

  useEffect(() => {
    let active = true;
    void client.getRolesConfig().then((config) => {
      if (active) setRolesConfig(config);
    }, () => {
      // Summary card is advisory; preflight/launch continue cleanly if roles fail to load.
    });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    const content = body.current;
    if (!content) return;
    content.scrollTop = 0;
    content.focus({ preventScroll: true });
  }, [step]);

  function move(direction: 'back' | 'next') {
    rfc.dismissSkipWarning();
    setStartError(null);
    setStep((current) => getWizardStep(current, direction));
  }

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || blankRfc) return;
    setOverridesError(undefined);
    setStartError(null);

    let modelOverrides: StartPayload['model_overrides'];
    try {
      modelOverrides = parseOverrides(overrides, inspector.errors.overridesMustMapStrings);
    } catch (error) {
      setOverridesError(error instanceof SyntaxError
        ? inspector.errors.invalidOverridesJson
        : inspector.errors.overridesMustMapStrings);
      return;
    }

    setSubmitting(true);
    try {
      const { run_id, daemon_pid } = await client.startRun({
        rfc_markdown: rfc.markdown,
        mode,
        ...(modelOverrides === undefined ? {} : { model_overrides: modelOverrides }),
      });
      onToast(toasts.runStarted(run_id, daemon_pid), 'ok');
      onClose();
      onStarted(run_id);
    } catch (error) {
      const isTimeout = (error instanceof ApiError && error.status === 408)
        || (error instanceof Error && error.name === 'AbortError');
      if (isTimeout) {
        setStartError({ kind: 'timeout' });
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        setStartError({ kind: 'error', detail });
        onToast(detail, 'err');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open title={inspector.modalStartTitle} onClose={() => { if (!busy) onClose(); }}>
      <div className="start-run-wizard">
        <ol className="start-run-wizard__steps" aria-label={inspector.modalStartTitle}>
          {WIZARD_STEPS.map((name, index) => (
            <li key={name} aria-current={step === name ? 'step' : undefined} data-complete={index < stepIndex}>
              <span className="start-run-wizard__step-number">
                {index < stepIndex ? <Check size={14} aria-hidden="true" /> : index + 1}
              </span>
              {wizard.steps[name]}
            </li>
          ))}
        </ol>

        <div className="start-run-wizard__body" ref={body} tabIndex={-1} role="region" aria-label={wizard.steps[step]}>
          <div hidden={step !== 'preflight'}>
            <PreflightStep
              client={client}
              active={step === 'preflight'}
              saving={savingCredentials}
              onSavingChange={setSavingCredentials}
            />
          </div>
          <div hidden={step !== 'brainstorm'}>
            <RfcStep rfc={rfc} onConfirmSkip={() => move('next')} />
          </div>
          {step === 'launch' && (
            <div className="grid gap-3">
              <Card>
                <CardContent className="pt-3.5">
                  <form id={`${id}-start`} className="grid gap-3" onSubmit={(event) => void startRun(event)}>
                    <div className="start-run-wizard__field">
                      <Label htmlFor={`${id}-mode`}>{inspector.runModeLabel}</Label>
                      <Select
                        id={`${id}-mode`}
                        value={mode}
                        disabled={submitting}
                        onChange={(event) => setMode(event.currentTarget.value === 'interactive' ? 'interactive' : 'overnight')}
                      >
                        <option value="overnight">{wizard.runModes.overnight}</option>
                        <option value="interactive">{wizard.runModes.interactive}</option>
                      </Select>
                    </div>
                    <div className="start-run-wizard__field">
                      <Label htmlFor={`${id}-overrides`}>{inspector.modelOverridesLabel}</Label>
                      <Textarea
                        id={`${id}-overrides`}
                        className="font-mono"
                        aria-invalid={Boolean(overridesError)}
                        aria-describedby={overridesError ? `${id}-overrides-error` : undefined}
                        rows={3}
                        value={overrides}
                        disabled={submitting}
                        onChange={(event) => {
                          setOverrides(event.currentTarget.value);
                          setOverridesError(undefined);
                        }}
                      />
                      {overridesError && (
                        <p className="start-run-wizard__error" id={`${id}-overrides-error`} role="alert">{overridesError}</p>
                      )}
                    </div>
                    {blankRfc && <p className="start-run-wizard__error" role="alert">{inspector.errors.enterRfcMarkdown}</p>}
                    {startError && (
                      <p className="start-run-wizard__error" role="alert">
                        {startError.kind === 'timeout'
                          ? inspector.startTimeoutError
                          : startError.detail
                            ? `${copy.startError} (${startError.detail})`
                            : copy.startError}
                      </p>
                    )}
                  </form>
                </CardContent>
              </Card>

              <Card className="bg-muted/35">
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                      <ShieldCheck size={14} className="text-[var(--emerald)]" aria-hidden="true" />
                      <span>{wizard.launchSummary.title}</span>
                    </CardTitle>
                    {rolesConfig && (
                      <Badge variant="info" className="text-[10.5px]">
                        {wizard.launchSummary.budgetLabel}: {budgetCopy.options[rolesConfig.budget_profile]?.label ?? rolesConfig.budget_profile}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3 pt-1">
                  {rolesConfig && (
                    <div className="grid gap-1.5">
                      <h4 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {wizard.launchSummary.rolesTitle}
                      </h4>
                      <div className="grid gap-1">
                        {(['tactical_planner', 'critical_executor', 'micro_orchestrator', 'bulk_worker', 'milestone_reviewer'] as const)
                          .filter((roleKey) => Object.hasOwn(rolesConfig.roles, roleKey))
                          .map((roleKey) => {
                            const cfg = rolesConfig.roles[roleKey];
                            const cap = rolesConfig.providers[cfg.provider]?.max_concurrency;
                            const providerLabel = formatProviderDisplay(cfg.provider);
                            return (
                              <div
                                key={roleKey}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs"
                              >
                                <span className="font-medium text-text-strong">
                                  {translateRole(roleKey, locale)}
                                </span>
                                <span className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                                  <span className="text-foreground">
                                    {providerLabel} / {cfg.model}
                                  </span>
                                  {typeof cap === 'number' && cap > 0 && (
                                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                                      {wizard.launchSummary.concurrencyLabel(cap)}
                                    </Badge>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}

                  <div className="grid gap-1.5">
                    <h4 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {wizard.launchSummary.guardsTitle}
                    </h4>
                    <ul className="m-0 grid gap-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
                      {wizard.launchSummary.guards.map((guard) => (
                        <li key={guard}>{guard}</li>
                      ))}
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        <div className="start-run-wizard__footer">
          {step === 'preflight' ? (
            <Button variant="ghost" onClick={onClose} disabled={busy}>{inspector.cancel}</Button>
          ) : (
            <Button variant="ghost" onClick={() => move('back')} disabled={busy || Boolean(rfc.operation)}>
              <ArrowLeft size={14} aria-hidden="true" />
              {copy.back}
            </Button>
          )}
          <div className="start-run-wizard__actions">
            {step === 'brainstorm' && (
              <Button
                disabled={Boolean(rfc.operation || rfc.skipWarning)}
                onClick={() => void rfc.skip(() => move('next'))}
              >
                {wizard.skipBrainstorm}
              </Button>
            )}
            {step === 'launch' ? (
              <Button form={`${id}-start`} variant="default" type="submit" disabled={submitting || blankRfc}>
                <Play size={14} aria-hidden="true" />
                {submitting ? inspector.startingRun : wizard.startRealRun}
              </Button>
            ) : (
              <Button
                variant="default"
                disabled={busy || (step === 'brainstorm' && (!canAdvanceRfc || Boolean(rfc.operation || rfc.skipWarning)))}
                onClick={() => move('next')}
              >
                {copy.next}
                <ArrowRight size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
