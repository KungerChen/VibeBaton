import './PricingModal.css';
import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { BatonApiClient } from '../../api/client';
import { useI18n } from '../../i18n';
import type { CustomPricingUpdate, PricingModelEntry, PricingStatusResponse } from '../../types/graph';
import { Badge, type BadgeProps } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Modal } from '../ui/Modal';
import { formatUsd } from './billingFormat';

export interface PricingModalProps {
  open: boolean;
  onClose(): void;
  client: Pick<BatonApiClient, 'getPricing' | 'syncPricing' | 'saveCustomPricing'>;
}

const rateColumns = [
  ['input_per_1m', 'input'],
  ['cached_input_per_1m', 'cached'],
  ['output_per_1m', 'output'],
] as const;

type RateField = (typeof rateColumns)[number][0];

interface EditDraft {
  model: string;
  rates: Record<RateField, string>;
  submitted: boolean;
}

function parseRate(value: string): number | null {
  if (!value.trim()) return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}

export function PricingModal({ open, client, onClose }: PricingModalProps) {
  const pendingChange = useRef<Promise<void> | null>(null);
  return open ? <PricingDialog client={client} onClose={onClose} pendingChange={pendingChange} /> : null;
}

type PricingDialogProps = Omit<PricingModalProps, 'open'> & {
  pendingChange: RefObject<Promise<void> | null>;
};

function PricingDialog({ client, onClose, pendingChange }: PricingDialogProps) {
  const { locale, messages: { pricing: copy } } = useI18n();
  const [catalog, setCatalog] = useState<PricingStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<'sync' | 'write' | null>(null);
  const [feedback, setFeedback] = useState<'syncFailed' | 'saved' | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const validationId = useId();
  const syncing = operation === 'sync';
  const busy = loading || operation !== null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setDraft(null);

    async function load() {
      // A reopened dialog reads the catalog after any previous write has settled.
      if (pendingChange.current) await pendingChange.current;
      if (!active) return;
      setFeedback(null);
      try {
        const next = await client.getPricing();
        if (active) setCatalog(next);
      } catch {
        if (active) {
          setCatalog(null);
          setFeedback('syncFailed');
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => { active = false; };
  }, [client, pendingChange]);

  function changePricing(kind: 'sync' | 'write', change: () => Promise<void>) {
    if (loading || pendingChange.current) return;
    setOperation(kind);
    setFeedback(null);
    pendingChange.current = change().finally(() => {
      pendingChange.current = null;
      setOperation(null);
    });
  }

  function syncPrices() {
    changePricing('sync', async () => {
      try {
        const result = await client.syncPricing(true);
        setCatalog(result.catalog);
        if (!result.ok) setFeedback('syncFailed');
      } catch {
        setFeedback('syncFailed');
      }
    });
  }

  function beginEdit(entry: PricingModelEntry) {
    setFeedback(null);
    setDraft({
      model: entry.model,
      rates: {
        input_per_1m: String(entry.input_per_1m),
        cached_input_per_1m: String(entry.cached_input_per_1m),
        output_per_1m: String(entry.output_per_1m),
      },
      submitted: false,
    });
  }

  function writeRates(model: string, rates: CustomPricingUpdate[string]) {
    changePricing('write', async () => {
      try {
        const next = await client.saveCustomPricing({ [model]: rates });
        setCatalog(next);
        setDraft((current) => current?.model === model ? null : current);
        setFeedback('saved');
      } catch {
        // Keep the current rates and draft available for retry.
      }
    });
  }

  function saveDraft() {
    if (!draft) return;
    const input = parseRate(draft.rates.input_per_1m);
    const cached = parseRate(draft.rates.cached_input_per_1m);
    const output = parseRate(draft.rates.output_per_1m);
    if (input === null || cached === null || output === null) {
      setDraft({ ...draft, submitted: true });
      return;
    }
    writeRates(draft.model, { input_per_1m: input, cached_input_per_1m: cached, output_per_1m: output });
  }

  const cache = loading ? undefined : catalog?.cache;
  const date = cache?.fetched_at ? new Date(cache.fetched_at) : null;
  const lastSynced = date && Number.isFinite(date.getTime())
    ? date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : null;
  const sourceBadges = {
    custom: { variant: 'default', children: copy.sourceCustom },
    official_cache: { variant: 'info', children: copy.sourceOfficialCache },
    builtin: { variant: 'outline', children: copy.sourceBuiltin },
  } as const satisfies Record<PricingModelEntry['source'], BadgeProps>;
  const invalid = draft?.submitted && rateColumns.some(([field]) => parseRate(draft.rates[field]) === null);

  return (
    <Modal open title={copy.title} onClose={onClose}>
      <div className="pricing-modal">
        <div className="pricing-modal__sync" aria-busy={loading}>
          {cache && (
            <div className="pricing-modal__sync-status">
              <Badge variant={cache.stale ? 'warning' : 'outline'} role="status">
                {lastSynced ? (
                  <>
                    {copy.lastSynced}{' '}
                    <time dateTime={cache.fetched_at ?? undefined}>{lastSynced}</time>
                  </>
                ) : copy.neverSynced}
              </Badge>
              {cache.auto_sync && cache.refresh_interval_hours === 24 && (
                <span className="pricing-modal__interval">{copy.autoSyncEvery24h}</span>
              )}
              {cache.stale && <Badge variant="warning">{copy.stale}</Badge>}
            </div>
          )}
          <Button size="sm" onClick={syncPrices} disabled={busy} aria-busy={syncing}>
            <RefreshCw size={14} className={syncing ? 'pricing-modal__spin' : undefined} aria-hidden="true" />
            {syncing ? copy.syncing : copy.syncButton}
          </Button>
        </div>
        {feedback === 'syncFailed' && <p className="pricing-modal__error" role="alert">{copy.syncFailed}</p>}
        {feedback === 'saved' && <Badge variant="success" role="status" className="pricing-modal__saved">{copy.saved}</Badge>}

        {!loading && catalog && (
          <div className="pricing-modal__table-wrap" tabIndex={0} role="region" aria-label={copy.unit}>
            <table className="pricing-modal__table">
              <caption>{copy.unit}</caption>
              <thead>
                <tr>
                  <th scope="col">{copy.columns.model}</th>
                  <th scope="col">{copy.columns.source}</th>
                  {rateColumns.map(([field, column]) => (
                    <th key={field} scope="col" className="pricing-modal__num">{copy.columns[column]}</th>
                  ))}
                  <th scope="col" className="pricing-modal__actions">{copy.columns.actions}</th>
                </tr>
              </thead>
              <tbody>
                {catalog.models.map((entry) => {
                  const editing = draft?.model === entry.model ? draft : null;
                  return (
                    <tr key={entry.model}>
                      <th scope="row" className="pricing-modal__model"><code>{entry.model}</code></th>
                      <td><Badge {...sourceBadges[entry.source]} /></td>
                      {rateColumns.map(([field, column]) => {
                        const invalidField = editing?.submitted && parseRate(editing.rates[field]) === null;
                        return (
                          <td key={field} className="pricing-modal__num">
                            {editing ? (
                              <Input
                                type="number"
                                min={0}
                                step="any"
                                inputMode="decimal"
                                aria-label={`${copy.columns[column]} ${entry.model}`}
                                aria-invalid={invalidField || undefined}
                                aria-describedby={invalidField ? validationId : undefined}
                                value={editing.rates[field]}
                                disabled={busy}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setDraft((current) => current?.model === entry.model
                                    ? { ...current, rates: { ...current.rates, [field]: value } }
                                    : current);
                                }}
                              />
                            ) : formatUsd(entry[field], locale)}
                          </td>
                        );
                      })}
                      <td className="pricing-modal__actions">
                        <div className="pricing-modal__row-actions">
                          {editing ? (
                            <>
                              <Button size="xs" variant="default" disabled={busy} onClick={saveDraft}>{copy.save}</Button>
                              <Button size="xs" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{copy.cancel}</Button>
                            </>
                          ) : (
                            <Button size="xs" variant="ghost" disabled={busy} onClick={() => beginEdit(entry)}>{copy.edit}</Button>
                          )}
                          {entry.source === 'custom' && (
                            <Button size="xs" variant="ghost" disabled={busy} onClick={() => writeRates(entry.model, null)}>
                              {copy.resetToOfficial}
                            </Button>
                          )}
                        </div>
                        {editing && invalid && (
                          <p id={validationId} className="pricing-modal__error" role="alert">{copy.invalidNumber}</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="pricing-modal__footer">
          <Button variant="ghost" onClick={onClose}>{copy.close}</Button>
        </div>
      </div>
    </Modal>
  );
}
