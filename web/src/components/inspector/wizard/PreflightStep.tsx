import { Copy } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import type { BatonApiClient } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { formatProviderDisplay, translatePresetText } from '../../../i18n/presets';
import type { DoctorRoleResult, PresetItem, WorkflowGraph } from '../../../types/graph';
import { useReadinessTime, useWorkspaceReadiness } from '../../CanvasWorkspace';
import { getReadinessState, type ReadinessState } from '../../nodes/readiness';
import { Badge, type BadgeProps } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { probeDoctorRole } from '../GraphEditor';
import { findReadyPreset, getInstallCommand, getPreflightProviderState } from '../launchWizard';
import { CredentialSetup } from './CredentialSetup';
import { LAUNCH_MESSAGES } from './messages';

export const LaunchGraphContext = createContext<Pick<WorkflowGraph, 'id' | 'name' | 'required_providers'> | null>(null);

const statusVariants: Record<ReadinessState, BadgeProps['variant']> = {
  ready: 'success',
  cooldown: 'warning',
  missing: 'destructive',
};

type ProviderRowProps = {
  client: BatonApiClient;
  provider: string;
  state: ReadinessState;
  installHint?: string;
  checkHint: boolean;
  now: number;
};

function ProviderRow({ client, provider, state, installHint, checkHint, now }: ProviderRowProps) {
  const { locale, messages: { credentials, nodeReadiness } } = useI18n();
  const copy = LAUNCH_MESSAGES[locale];
  const [probe, setProbe] = useState<DoctorRoleResult | null>(null);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'error'>();
  const needsProbe = checkHint && state === 'missing' && !installHint;

  useEffect(() => {
    if (!needsProbe) return;
    let current = true;
    void probeDoctorRole(client, { provider }).then(
      (result) => { if (current) setProbe(result); },
      () => {},
    );
    return () => { current = false; };
  }, [client, needsProbe, provider]);

  const status = state === 'missing' && probe ? getReadinessState(probe, now) : state;
  const hint = status === 'missing' ? (installHint || probe?.install_hint) : undefined;
  const command = hint ? getInstallCommand(hint) : undefined;

  async function copyCommand(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }

  return (
    <li className="start-run-wizard__provider">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-text-strong">{formatProviderDisplay(provider)}</span>
        <Badge variant={statusVariants[status]}>{nodeReadiness.statuses[status]}</Badge>
      </div>
      {command ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="start-run-wizard__command">{command}</code>
          <Button size="xs" title={credentials.copyCommandHint} onClick={() => void copyCommand(command)}>
            <Copy size={12} aria-hidden="true" />
            {copyStatus === 'copied' ? copy.copied : credentials.copyCommand}
          </Button>
          {copyStatus === 'error' && <p className="start-run-wizard__note" role="status">{copy.copyError}</p>}
        </div>
      ) : hint && <p className="start-run-wizard__note">{hint}</p>}
    </li>
  );
}

type PreflightStepProps = {
  client: BatonApiClient;
  active: boolean;
  saving: boolean;
  onSavingChange(saving: boolean): void;
};

export function PreflightStep({ client, active, saving, onSavingChange }: PreflightStepProps) {
  const { locale, messages: { credentials, wizard } } = useI18n();
  const copy = LAUNCH_MESSAGES[locale];
  const graph = useContext(LaunchGraphContext);
  const { providerHealth } = useWorkspaceReadiness();
  const now = useReadinessTime(providerHealth);
  const [presetId, setPresetId] = useState<string>();
  const [catalog, setCatalog] = useState<{ phase: 'loading' | 'ready' | 'error'; presets: PresetItem[] }>({
    phase: 'loading',
    presets: [],
  });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    void client.listPresets().then(
      (presets) => { if (current) setCatalog({ phase: 'ready', presets }); },
      () => { if (current) setCatalog((previous) => ({ ...previous, phase: 'error' })); },
    );
    return () => { current = false; };
  }, [client, revision]);

  function refreshPresets() {
    setCatalog((previous) => ({ ...previous, phase: 'loading' }));
    setRevision((previous) => previous + 1);
  }

  const preset = catalog.presets.find(({ id }) => id === (presetId ?? graph?.id))
    ?? (!graph ? catalog.presets[0] : undefined);
  const name = preset?.name ?? graph?.name;
  const providers = preset?.required_providers ?? (preset?.graph ?? graph)?.required_providers ?? [];
  const readyPreset = findReadyPreset(catalog.presets);

  return (
    <div className="grid gap-3">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <p className="start-run-wizard__note">{copy.preflightPreset}</p>
            <CardTitle>{name ? translatePresetText(name, locale) : wizard.steps.preflight}</CardTitle>
          </div>
          {readyPreset && readyPreset.id !== (preset?.id ?? graph?.id) && preset?.host_ready !== true && (
            <Button
              size="sm"
              disabled={catalog.phase !== 'ready' || saving}
              onClick={() => setPresetId(readyPreset.id)}
            >
              {wizard.switchToReadyPreset}
            </Button>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          {catalog.phase === 'loading' && <p className="start-run-wizard__note" role="status">{copy.checkingProviders}</p>}
          {catalog.phase === 'error' && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="start-run-wizard__error" role="alert">{copy.presetError}</p>
              <Button size="sm" onClick={refreshPresets}>{copy.retry}</Button>
            </div>
          )}
          {providers.length > 0 ? (
            <ul className="start-run-wizard__providers">
              {providers.map((provider) => {
                const health = providerHealth.get(provider);
                return (
                  <ProviderRow
                    key={`${provider}:${revision}`}
                    client={client}
                    provider={provider}
                    state={getPreflightProviderState(provider, preset, health, now)}
                    installHint={revision === 0 ? health?.install_hint : undefined}
                    checkHint={active && catalog.phase !== 'loading'}
                    now={now}
                  />
                );
              })}
            </ul>
          ) : catalog.phase !== 'loading' && <p className="start-run-wizard__note">{copy.noRequiredProviders}</p>}
          {catalog.phase === 'ready' && !readyPreset && (
            <p className="start-run-wizard__note">{copy.noReadyPresets}</p>
          )}
          <p className="start-run-wizard__note">{credentials.manualLoginNote}</p>
        </CardContent>
      </Card>
      <CredentialSetup client={client} saving={saving} onSavingChange={onSavingChange} onSaved={refreshPresets} />
    </div>
  );
}
