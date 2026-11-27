import { useId, type ChangeEvent } from 'react';
import type { L0ModelOption, ModelCatalogResponse } from '../../api/client';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Select } from '../ui/input';
import { effortOptionsFor, modelsForProvider } from './GuidedSetupStep';
import './L0ModelSwitcher.css';

export interface L0ModelSwitcherOption extends L0ModelOption {
  /** The API lists ready models; a caller may pass a known-unready entry with `ready: false`. */
  ready?: boolean;
  /** Plain text explaining why the model is not selectable. */
  reason?: string | null;
}

export interface L0ModelSwitcherProps {
  /** Accepts every `L0ModelOption[]`; the optional readiness fields only refine a known-unready entry. */
  models: L0ModelSwitcherOption[];
  /** `null` selects automatic mode. */
  selected: string | null;
  autoSelected: string | null;
  loading: boolean;
  error?: string | null;
  catalog?: Pick<ModelCatalogResponse, 'models' | 'efforts'>;
  onChange(spec: string | null): void;
  onRetry(): void;
}

function splitL0Spec(spec: string): { provider: string; model: string; effort: string; base: string } {
  const colon = spec.indexOf(':');
  const provider = colon >= 0 ? spec.slice(0, colon) : '';
  const rest = colon >= 0 ? spec.slice(colon + 1) : spec;
  const at = rest.indexOf('@');
  const model = at >= 0 ? rest.slice(0, at) : rest;
  const effort = at >= 0 ? rest.slice(at + 1) : '';
  return { provider, model, effort, base: provider ? `${provider}:${model}` : model };
}

/** A presentational leaf: its parent loads the models and persists the selection. */
export function L0ModelSwitcher({
  models,
  selected,
  autoSelected,
  loading,
  error,
  catalog,
  onChange,
  onRetry,
}: L0ModelSwitcherProps) {
  const { messages } = useI18n();
  const copy = messages.guided.m3.l0Model;
  const labelId = useId();
  const selectId = useId();
  const effortId = useId();
  const currentId = useId();
  const detail = error?.trim() ?? '';
  const selectedSpec = selected;
  const parsedSelected = selectedSpec !== null ? splitL0Spec(selectedSpec) : null;
  const exactCurrent = models.find((model) => model.spec === selectedSpec) ?? null;
  const current = exactCurrent ?? (
    parsedSelected && parsedSelected.provider
      ? models.find((model) => model.provider === parsedSelected.provider && model.model === parsedSelected.model) ?? null
      : null
  );
  const automaticModel = models.find((model) => model.spec === autoSelected && model.ready !== false) ?? null;
  const activeModel = (current && current.ready !== false ? current : null) ?? automaticModel;
  const catalogModel = activeModel && catalog
    ? modelsForProvider(catalog.models, activeModel.provider).find((model) => model.id === activeModel.model)
    : undefined;
  const efforts = activeModel && catalog
    ? effortOptionsFor(catalogModel, activeModel.provider, catalog.efforts)
    : [];
  const selectedEffort = parsedSelected?.effort || activeModel?.effort || '';
  const effortLabel = efforts.find((effort) => effort.id === selectedEffort)?.label ?? selectedEffort;
  const currentLabel = selectedSpec === null
    ? automaticModel ? `${copy.auto} — ${automaticModel.label}` : copy.auto
    : current
      ? (parsedSelected?.effort && parsedSelected.effort !== (current.effort ?? '') && effortLabel
        ? `${current.label} · ${effortLabel}`
        : current.label)
      : selectedSpec;
  const missingSelection = selectedSpec !== null && current === null ? selectedSpec : null;
  const modelSelectValue = current ? current.spec : (selectedSpec ?? '');
  const hasReady = models.some((model) => model.ready !== false);
  const selectable = !loading && !(detail && models.length === 0);
  const unavailableReason = messages.guided.setup.scanSummary(0, 1);

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const spec = event.currentTarget.value;
    const model = models.find((entry) => entry.spec === spec);
    if (spec === '') onChange(null);
    else if (model && model.ready !== false) onChange(spec);
  }

  function handleEffortChange(event: ChangeEvent<HTMLSelectElement>) {
    if (!activeModel) return;
    const nextEffort = event.currentTarget.value;
    onChange(nextEffort ? `${activeModel.provider}:${activeModel.model}@${nextEffort}` : `${activeModel.provider}:${activeModel.model}`);
  }

  return (
    <section className="l0-model-switcher" aria-labelledby={labelId}>
      <label id={labelId} className="l0-model-switcher__label" htmlFor={selectId}>
        {copy.label}
      </label>
      <Select
        id={selectId}
        className="l0-model-switcher__select w-auto"
        value={modelSelectValue}
        disabled={!selectable}
        aria-describedby={currentId}
        onChange={handleChange}
      >
        <option value="">{copy.auto}</option>
        {models.map((model) => {
          const ready = model.ready !== false;
          const recommended = ready && model.spec === autoSelected;
          const reason = model.reason?.trim() || unavailableReason;
          return (
            <option
              key={model.spec}
              value={model.spec}
              disabled={!ready}
              data-recommended={recommended ? 'true' : undefined}
              title={ready ? undefined : reason}
            >
              {model.label}
              {recommended ? ` · ${messages.guided.setup.presetRecommended}` : ''}
              {ready ? '' : ` — ${reason}`}
            </option>
          );
        })}
        {missingSelection !== null ? (
          <option value={missingSelection} disabled>
            {missingSelection}{!loading && !detail ? ` — ${unavailableReason}` : ''}
          </option>
        ) : null}
      </Select>
      {catalog && activeModel && efforts.length > 0 ? (
        <Select
          id={effortId}
          className="l0-model-switcher__effort w-auto"
          aria-label={messages.guided.m3.lineup.effort}
          value={selectedEffort}
          disabled={!selectable}
          onChange={handleEffortChange}
        >
          {selectedEffort && !efforts.some((effort) => effort.id === selectedEffort) ? (
            <option value={selectedEffort}>{selectedEffort}</option>
          ) : null}
          {efforts.map((effort) => (
            <option key={effort.id} value={effort.id}>{effort.label}</option>
          ))}
        </Select>
      ) : null}
      <span id={currentId} className="l0-model-switcher__current">
        {copy.selected}: <strong>{currentLabel}</strong>
      </span>
      {loading ? (
        <span className="l0-model-switcher__status" role="status">{copy.loading}</span>
      ) : null}
      {!loading && detail ? (
        <span className="l0-model-switcher__error">
          <span role="alert">{copy.failed} {detail}</span>
          <Button size="xs" variant="ghost" onClick={onRetry}>{copy.retry}</Button>
        </span>
      ) : null}
      {!loading && !detail && !hasReady ? (
        <span className="l0-model-switcher__status">{copy.unavailable}</span>
      ) : null}
    </section>
  );
}
