import { act, Children, createElement, isValidElement } from 'react';
import type { ChangeEvent, ComponentProps, MouseEvent, ReactElement, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MESSAGES, type Locale } from '../../i18n/messages';
import type { PricingModelEntry, PricingStatusResponse, PricingSyncResponse } from '../../types/graph';
import { Button, type ButtonProps } from '../ui/button';
import { Input } from '../ui/input';
import { Modal } from '../ui/Modal';
import { formatUsd } from './billingFormat';
import { PricingModal, type PricingModalProps } from './PricingModal';

vi.mock('../ui/Modal', () => ({ Modal: vi.fn(() => null) }));

const custom: PricingModelEntry = {
  model: 'custom-model',
  source: 'custom',
  input_per_1m: 0.3,
  cached_input_per_1m: 0.006,
  output_per_1m: 1.2,
};

const official: PricingModelEntry = {
  model: 'official-model',
  source: 'official_cache',
  input_per_1m: 3,
  cached_input_per_1m: 0.3,
  output_per_1m: 15,
};

const builtin: PricingModelEntry = {
  model: 'builtin-model',
  source: 'builtin',
  input_per_1m: 2.5,
  cached_input_per_1m: 1.25,
  output_per_1m: 10,
};

const catalog: PricingStatusResponse = {
  models: [custom, official, builtin],
  cache: {
    path: 'pricing-cache.json',
    fetched_at: null,
    age_sec: null,
    stale: true,
    refresh_interval_hours: 24,
    auto_sync: true,
    source_url: 'https://example.test/pricing.json',
  },
  custom_path: 'custom-pricing.json',
};

const fetchedAt = '2026-11-22T09:00:00Z';
const synced: PricingSyncResponse = {
  ok: true,
  fetched: true,
  skipped_fresh: false,
  model_count: 3,
  error: null,
  catalog: { ...catalog, cache: { ...catalog.cache, fetched_at: fetchedAt, age_sec: 0, stale: false } },
};

function mockClient() {
  return {
    getPricing: vi.fn<PricingModalProps['client']['getPricing']>().mockResolvedValue(catalog),
    syncPricing: vi.fn<PricingModalProps['client']['syncPricing']>().mockResolvedValue(synced),
    saveCustomPricing: vi.fn<PricingModalProps['client']['saveCustomPricing']>().mockResolvedValue(catalog),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type ElementWithChildren = ReactElement<{ children?: ReactNode }>;

function elements(node: ReactNode): ElementWithChildren[] {
  return Children.toArray(node).flatMap((child) => isValidElement<{ children?: ReactNode }>(child)
    ? [child, ...elements(child.props.children)]
    : []);
}

function button(node: ReactNode, label: string): ButtonProps {
  const match = elements(node).find((element) =>
    element.type === Button && Children.toArray(element.props.children).includes(label));
  if (!match) throw new Error(`Missing button: ${label}`);
  return (match as ReactElement<ButtonProps>).props;
}

function input(node: ReactNode, label: string) {
  type InputProps = ComponentProps<typeof Input>;
  const match = elements(node).find((element) =>
    element.type === Input && (element as ReactElement<InputProps>).props['aria-label'] === label);
  if (!match) throw new Error(`Missing input: ${label}`);
  return (match as ReactElement<InputProps>).props;
}

async function click(props: ButtonProps) {
  expect(props.disabled).not.toBe(true);
  await act(async () => props.onClick?.({} as MouseEvent<HTMLButtonElement>));
}

async function enterRate(node: ReactNode, label: string, value: string) {
  const props = input(node, label);
  expect(props).toMatchObject({ type: 'number', min: 0, step: 'any' });
  await act(async () => props.onChange?.({ currentTarget: { value } } as ChangeEvent<HTMLInputElement>));
}

describe('PricingModal', () => {
  const modal = vi.mocked(Modal);
  const storedLocale = vi.fn<() => Locale>();
  const copy = MESSAGES.en.pricing;
  let root: Root | undefined;

  beforeEach(() => {
    modal.mockClear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', {
      HTMLIFrameElement: class HTMLIFrameElement {},
      localStorage: { getItem: storedLocale },
    });
  });

  afterEach(() => {
    try {
      act(() => root?.unmount());
    } finally {
      root = undefined;
      vi.unstubAllGlobals();
    }
  });

  async function mount(
    client: PricingModalProps['client'],
    { locale = 'en', open = true }: { locale?: Locale; open?: boolean } = {},
  ) {
    storedLocale.mockReturnValue(locale);
    // The shared Modal is the host boundary. It renders null so the existing node runner can
    // exercise real PricingModal effects and handlers without a browser-specific test dependency.
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    const renderer = createRoot(container as unknown as HTMLElement);
    root = renderer;
    const onClose = vi.fn();

    async function setOpen(next: boolean) {
      modal.mockClear();
      await act(async () => renderer.render(createElement(I18nProvider, {
        children: createElement(PricingModal, { open: next, onClose, client }),
      })));
    }

    function dialog() {
      const last = modal.mock.lastCall?.[0];
      if (!last) throw new Error('Missing pricing dialog');
      return last;
    }

    function row(model: string) {
      const match = elements(dialog().children).find((element) =>
        element.type === 'tr' && elements(element).some((child) =>
          child.type === 'code' && child.props.children === model));
      if (!match) throw new Error(`Missing pricing row: ${model}`);
      return match;
    }

    await setOpen(open);
    return { dialog, row, setOpen, onClose };
  }

  test.each(['en', 'zh'] as const)('renders the localized pricing catalog in %s', async (locale) => {
    const localized = MESSAGES[locale].pricing;
    const { dialog, row, onClose } = await mount(mockClient(), { locale });
    expect(dialog().title).toBe(localized.title);
    const markup = renderToStaticMarkup(dialog().children);
    expect(markup).toContain(localized.unit);
    expect(markup).toContain(localized.neverSynced);
    expect(markup).toContain(localized.autoSyncEvery24h);
    expect(markup).toContain(localized.stale);
    expect(markup).not.toMatch(/opencode/i);
    for (const [entry, source] of [
      [custom, localized.sourceCustom],
      [official, localized.sourceOfficialCache],
      [builtin, localized.sourceBuiltin],
    ] as const) {
      const rowMarkup = renderToStaticMarkup(row(entry.model));
      expect(rowMarkup).toContain(source);
      expect(rowMarkup).toContain(formatUsd(entry.input_per_1m, locale));
      expect(rowMarkup).toContain(formatUsd(entry.cached_input_per_1m, locale));
      expect(rowMarkup).toContain(formatUsd(entry.output_per_1m, locale));
    }
    await click(button(dialog().children, localized.close));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('forces sync, marks it pending, and updates the date and stale badge', async () => {
    const client = mockClient();
    const pending = deferred<PricingSyncResponse>();
    client.syncPricing.mockReturnValueOnce(pending.promise);
    const { dialog, row } = await mount(client);
    await click(button(dialog().children, copy.syncButton));

    expect(client.syncPricing).toHaveBeenCalledExactlyOnceWith(true);
    expect(button(dialog().children, copy.syncing)).toMatchObject({ disabled: true, 'aria-busy': true });
    expect(button(row(builtin.model), copy.edit).disabled).toBe(true);

    await act(async () => pending.resolve(synced));
    const markup = renderToStaticMarkup(dialog().children);
    expect(markup).toContain(copy.lastSynced);
    expect(markup).toContain(`dateTime="${fetchedAt}"`);
    expect(markup).toContain(new Date(fetchedAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }));
    expect(markup).not.toContain(copy.neverSynced);
    expect(markup).not.toContain(copy.stale);
    expect(button(dialog().children, copy.syncButton).disabled).toBe(false);
  });

  test('reports an unsuccessful sync and keeps the returned catalog available', async () => {
    const client = mockClient();
    client.syncPricing.mockResolvedValueOnce({ ...synced, ok: false, catalog });
    const { dialog, row } = await mount(client);
    await click(button(dialog().children, copy.syncButton));

    expect(renderToStaticMarkup(dialog().children)).toContain(copy.syncFailed);
    expect(renderToStaticMarkup(row(official.model))).toContain(copy.sourceOfficialCache);
    expect(button(dialog().children, copy.syncButton).disabled).toBe(false);
  });

  test('can retry through sync when the initial catalog load fails', async () => {
    const client = mockClient();
    client.getPricing.mockRejectedValueOnce(new Error('offline'));
    const { dialog } = await mount(client);
    expect(renderToStaticMarkup(dialog().children)).toContain(copy.syncFailed);

    await click(button(dialog().children, copy.syncButton));
    expect(renderToStaticMarkup(dialog().children)).toContain(copy.lastSynced);
    expect(renderToStaticMarkup(dialog().children)).not.toContain(copy.syncFailed);
  });

  test('omits the 24-hour label when auto-sync is off', async () => {
    const client = mockClient();
    client.getPricing.mockResolvedValueOnce({ ...catalog, cache: { ...catalog.cache, auto_sync: false } });
    const { dialog } = await mount(client);
    expect(renderToStaticMarkup(dialog().children)).not.toContain(copy.autoSyncEvery24h);
  });

  test.each([
    { column: 'input', value: '' },
    { column: 'cached', value: '-1' },
    { column: 'output', value: '1e309' },
  ] as const)('rejects an invalid $column rate ($value) inline', async ({ column, value }) => {
    const client = mockClient();
    const { row } = await mount(client);
    const model = builtin.model;
    const label = `${copy.columns[column]} ${model}`;
    await click(button(row(model), copy.edit));
    await enterRate(row(model), label, value);
    await click(button(row(model), copy.save));

    expect(client.saveCustomPricing).not.toHaveBeenCalled();
    expect(input(row(model), label)['aria-invalid']).toBe(true);
    expect(renderToStaticMarkup(row(model))).toContain(copy.invalidNumber);
  });

  test('saves decimal and zero rates and displays the returned custom price', async () => {
    const client = mockClient();
    const rates = { input_per_1m: 1.5, cached_input_per_1m: 0, output_per_1m: 6.25 };
    client.saveCustomPricing.mockResolvedValueOnce({
      ...catalog,
      models: [custom, official, { ...builtin, ...rates, source: 'custom' }],
    });
    const { dialog, row } = await mount(client);
    const model = builtin.model;
    await click(button(row(model), copy.edit));
    await enterRate(row(model), `${copy.columns.input} ${model}`, '1.5');
    await enterRate(row(model), `${copy.columns.cached} ${model}`, '0');
    await enterRate(row(model), `${copy.columns.output} ${model}`, '6.25');
    await click(button(row(model), copy.save));

    expect(client.saveCustomPricing).toHaveBeenCalledExactlyOnceWith({ [model]: rates });
    const markup = renderToStaticMarkup(row(model));
    expect(markup).toContain(copy.sourceCustom);
    expect(markup).toContain(formatUsd(rates.input_per_1m, 'en'));
    expect(markup).not.toContain('type="number"');
    expect(renderToStaticMarkup(dialog().children)).toContain(copy.saved);
  });

  test('cancels edits without writing rates', async () => {
    const client = mockClient();
    const { row } = await mount(client);
    const model = builtin.model;
    await click(button(row(model), copy.edit));
    await enterRate(row(model), `${copy.columns.input} ${model}`, '25');
    await click(button(row(model), copy.cancel));

    expect(client.saveCustomPricing).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(row(model))).toContain(formatUsd(builtin.input_per_1m, 'en'));
    expect(renderToStaticMarkup(row(model))).not.toContain('type="number"');
  });

  test('resets only a custom row by sending a null override', async () => {
    const client = mockClient();
    client.saveCustomPricing.mockResolvedValueOnce({
      ...catalog,
      models: [{ ...custom, source: 'builtin' }, official, builtin],
    });
    const { row } = await mount(client);
    expect(renderToStaticMarkup(row(official.model))).not.toContain(copy.resetToOfficial);
    expect(renderToStaticMarkup(row(builtin.model))).not.toContain(copy.resetToOfficial);
    await click(button(row(custom.model), copy.resetToOfficial));

    expect(client.saveCustomPricing).toHaveBeenCalledExactlyOnceWith({ [custom.model]: null });
    expect(renderToStaticMarkup(row(custom.model))).toContain(copy.sourceBuiltin);
    expect(renderToStaticMarkup(row(custom.model))).not.toContain(copy.resetToOfficial);
  });

  test('loads on open and waits for a pending update before reloading', async () => {
    const client = mockClient();
    const pending = deferred<PricingStatusResponse>();
    client.saveCustomPricing.mockReturnValueOnce(pending.promise);
    const { dialog, row, setOpen } = await mount(client, { open: false });
    expect(client.getPricing).not.toHaveBeenCalled();
    expect(modal).not.toHaveBeenCalled();

    await setOpen(true);
    expect(client.getPricing).toHaveBeenCalledTimes(1);
    await click(button(row(custom.model), copy.resetToOfficial));
    expect(button(dialog().children, copy.syncButton).disabled).toBe(true);

    await setOpen(false);
    await setOpen(true);
    expect(client.getPricing).toHaveBeenCalledTimes(1);
    client.getPricing.mockResolvedValueOnce(synced.catalog);
    await act(async () => pending.resolve(catalog));
    expect(client.getPricing).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(dialog().children)).toContain(copy.lastSynced);
  });

  test('surfaces an inline alert when saving custom prices fails', async () => {
    const client = mockClient();
    client.saveCustomPricing.mockRejectedValueOnce(new Error('disk full'));
    const { dialog, row } = await mount(client);
    const model = builtin.model;
    await click(button(row(model), copy.edit));
    await enterRate(row(model), `${copy.columns.input} ${model}`, '2.0');
    await click(button(row(model), copy.save));

    const markup = renderToStaticMarkup(dialog().children);
    expect(markup).toContain(copy.saveFailed);
    expect(markup).toContain('role="alert"');
  });
});
