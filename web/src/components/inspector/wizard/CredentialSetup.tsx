import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { BatonApiClient } from '../../../api/client';
import { useI18n } from '../../../i18n';
import type { CredentialStatus } from '../../../types/graph';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { Input, Label } from '../../ui/input';
import { getMaskedCredential } from '../launchWizard';
import { LAUNCH_MESSAGES } from './messages';

type CredentialSetupProps = {
  client: BatonApiClient;
  saving: boolean;
  onSavingChange(saving: boolean): void;
  onSaved(): void;
};

export function CredentialSetup({ client, saving, onSavingChange, onSaved }: CredentialSetupProps) {
  const { locale, messages: { credentials, nodeReadiness } } = useI18n();
  const copy = LAUNCH_MESSAGES[locale];
  const id = useId();
  const fields = Object.entries(credentials.keyLabels);
  const [statuses, setStatuses] = useState<CredentialStatus[]>();
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [feedback, setFeedback] = useState<'saved' | 'error' | null>(null);
  const [hasUpdates, setHasUpdates] = useState(false);

  useEffect(() => {
    let current = true;
    void client.listCredentials().then(
      (result) => { if (current) setStatuses(result); },
      () => { if (current) setLoadError(true); },
    );
    return () => { current = false; };
  }, [client, loadAttempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !statuses) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const updates: Record<string, string> = {};
    for (const [key] of fields) {
      const value = data.get(key);
      if (typeof value === 'string' && value.trim()) updates[key] = value;
    }
    if (Object.keys(updates).length === 0) return;

    setFeedback(null);
    onSavingChange(true);
    try {
      const result = await client.saveCredentials(updates);
      form.reset();
      setHasUpdates(false);
      setStatuses(result);
      setFeedback('saved');
      onSaved();
    } catch {
      setFeedback('error');
    } finally {
      onSavingChange(false);
    }
  }

  return (
    <Card>
      <details className="start-run-wizard__credentials">
        <summary className="flex items-center justify-between gap-2 p-3.5 text-sm font-semibold text-text-strong">
          {copy.apiKeys}
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <form
          className="grid gap-3 px-3.5 pb-3.5"
          onSubmit={(event) => void save(event)}
          onChange={(event) => {
            const data = new FormData(event.currentTarget);
            setHasUpdates(fields.some(([key]) => String(data.get(key) ?? '').trim() !== ''));
            setFeedback(null);
          }}
        >
          <p className="m-0 text-xs text-muted-foreground" id={`${id}-mask-note`}>{credentials.maskedNote}</p>
          {!statuses && (
            <div className="flex flex-wrap items-center gap-2">
              {loadError ? (
                <>
                  <p className="start-run-wizard__error" role="alert">{copy.credentialsError}</p>
                  <Button size="sm" onClick={() => {
                    setLoadError(false);
                    setLoadAttempt((attempt) => attempt + 1);
                  }}>{copy.retry}</Button>
                </>
              ) : <p className="start-run-wizard__note" role="status">{copy.credentialsLoading}</p>}
            </div>
          )}
          <fieldset className="start-run-wizard__columns" disabled={!statuses || saving} aria-describedby={`${id}-mask-note`}>
            {fields.map(([key, label]) => {
              const masked = getMaskedCredential(statuses?.find((status) => status.provider_key === key));
              const inputId = `${id}-${key}`;
              return (
                <div className="start-run-wizard__field" key={key}>
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <Label htmlFor={inputId}>{label}</Label>
                    {statuses && (
                      <Badge variant={masked ? 'success' : 'outline'}>
                        {masked ? <code>{masked}</code> : nodeReadiness.statuses.missing}
                      </Badge>
                    )}
                  </div>
                  <Input id={inputId} name={key} type="password" autoComplete="new-password" spellCheck={false} />
                </div>
              );
            })}
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" variant="secondary" disabled={!statuses || !hasUpdates || saving}>
              {saving ? copy.credentialsSaving : credentials.save}
            </Button>
            {feedback === 'saved' && <p className="start-run-wizard__note" role="status">{copy.credentialsSaved}</p>}
            {feedback === 'error' && <p className="start-run-wizard__error" role="alert">{copy.credentialsSaveError}</p>}
          </div>
        </form>
      </details>
    </Card>
  );
}
