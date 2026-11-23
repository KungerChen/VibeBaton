import { act, Children, createElement, isValidElement } from 'react';
import type { ComponentProps, MouseEvent, ReactElement, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert, expect, test, vi } from 'vitest';
import { BatonApiClient } from '../api/client';
import { flagship_4tier } from '../data/presets/flagship_4tier';
import goldenCase from '../engine/__fixtures__/goldenCase.json';
import { detectTransferInput, parseAndValidateCaseBundle } from '../engine/caseReplay';
import { MESSAGES } from '../i18n/messages';
import type { WorkflowGraph } from '../types/graph';
import { ExportCaseModal, ImportTransferModal } from './RecipeTransferModals';
import exportCaseSource from './transfer/ExportCaseModal.tsx?raw';
import exportRecipeSource from './transfer/ExportRecipeModal.tsx?raw';
import importTransferSource from './transfer/ImportTransferModal.tsx?raw';
import { checklistRows, serializeCase } from './transfer/exportCase';
import { serializeRecipe } from './transfer/exportRecipe';
import * as importPreview from './transfer/importPreview';
import { Modal } from './ui/Modal';
import { Button, type ButtonProps } from './ui/button';
import { Textarea } from './ui/input';

vi.mock('./ui/Modal', () => ({ Modal: vi.fn(() => null) }));

function elements(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<{ children?: ReactNode }>(child)
    ? [child, ...elements(child.props.children)]
    : []);
}

// Capture the real dialog controls in the Node test environment.
function createModalTestRoot() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {}, setTimeout, clearTimeout });
  const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
  return createRoot(container as unknown as HTMLElement);
}

test('previews an exported recipe and applies the same detected graph on confirmation', async () => {
  const json = serializeRecipe(flagship_4tier);
  const buildPreview = vi.spyOn(importPreview, 'buildImportPreview');
  const onApplyRecipe = vi.fn<(graph: WorkflowGraph) => void>();
  const onLoadCase = vi.fn();
  const onClose = vi.fn();
  const copy = MESSAGES.en.transfer.importModal;
  const content = () => vi.mocked(Modal).mock.lastCall?.[0].children;

  const root = createModalTestRoot();

  try {
    await act(async () => root.render(createElement(ImportTransferModal, {
      open: true, canvasDirty: true, onClose, onApplyRecipe, onLoadCase,
    })));
    const textarea = elements(content()).find((element) => element.type === Textarea);
    const onChange = (textarea?.props as ComponentProps<typeof Textarea> | undefined)?.onChange;
    assert(onChange, 'Expected a paste field');
    await act(async () => onChange({ currentTarget: { value: json } } as Parameters<typeof onChange>[0]));

    const detected = buildPreview.mock.lastCall?.[0];
    assert(detected?.kind === 'recipe', 'Expected a detected recipe in the import preview');
    expect(detected.graph).toStrictEqual(flagship_4tier);
    expect(buildPreview.mock.results.at(-1)?.value).toMatchObject({ typeBadge: 'recipe', validationOk: true });
    const markup = renderToStaticMarkup(content());
    expect(markup).toContain(copy.detectRecipe);
    expect(markup).toContain(copy.overwriteWarning);
    expect(onApplyRecipe).not.toHaveBeenCalled();

    const applyButton = elements(content()).find((element) => element.type === Button
      && Children.toArray(element.props.children).includes(copy.applyRecipe));
    const applyProps = applyButton?.props as ButtonProps | undefined;
    assert(applyProps?.onClick, 'Expected an apply button');
    expect(applyProps.disabled).toBe(false);
    const confirm = applyProps.onClick;
    await act(async () => confirm({} as MouseEvent<HTMLButtonElement>));
    expect(onApplyRecipe).toHaveBeenCalledOnce();
    expect(onApplyRecipe.mock.calls[0][0]).toBe(detected.graph);
    expect(onLoadCase).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    try {
      act(() => root.unmount());
    } finally {
      buildPreview.mockRestore();
      vi.unstubAllGlobals();
    }
  }
});

test.each([
  { audit: 'server audit fails', serverClean: false, summary: goldenCase.summary, verifiedClean: false },
  { audit: 'client finds a residual email', serverClean: true, summary: 'Contact replay-test@example.invalid', verifiedClean: false },
  { audit: 'both audits pass', serverClean: true, summary: goldenCase.summary, verifiedClean: true },
])('gates all case export actions when $audit', async ({ serverClean, summary, verifiedClean }) => {
  const response = {
    ...goldenCase,
    summary,
    redaction_report: { ...goldenCase.redaction_report, clean: serverClean },
  };
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ status: 'ok', version: 'test' }))
    .mockResolvedValueOnce(Response.json(response));
  const client = new BatonApiClient('', fetchImpl);
  await expect(client.init()).resolves.toBe('local');

  const writeText = vi.fn<Clipboard['writeText']>().mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const root = createModalTestRoot();
  const copy = MESSAGES.en.transfer.exportCaseModal;

  try {
    await act(async () => root.render(createElement(ExportCaseModal, {
      open: true,
      client,
      runId: goldenCase.meta.source_run_id,
      defaultTitle: goldenCase.title,
      onClose: vi.fn(),
      onPreviewInPlayer: vi.fn(),
    })));
    await act(async () => vi.advanceTimersByTimeAsync(300));

    const content = vi.mocked(Modal).mock.lastCall?.[0].children;
    expect(renderToStaticMarkup(content)).toContain(verifiedClean ? copy.verifiedClean : copy.notClean);
    const controls = elements(content);
    const actions = [copy.download, copy.copyJson, copy.previewReplay].map((label) => {
      const button = controls.find((element) => element.type === Button && element.props.children === label);
      assert(button, `Expected the ${label} button`);
      return button.props as ButtonProps;
    });
    expect.soft(actions.map(({ disabled }) => disabled)).toEqual([!verifiedClean, !verifiedClean, !verifiedClean]);

    // Exercise the handler directly so the clipboard guard is tested independently of the button.
    const onCopy = actions[1].onClick;
    assert(onCopy, 'Expected a copy handler');
    await act(async () => onCopy({} as MouseEvent<HTMLButtonElement>));
    if (verifiedClean) {
      const parsed = parseAndValidateCaseBundle(response);
      assert(parsed.ok, 'Expected a valid Golden Case');
      expect(writeText).toHaveBeenCalledExactlyOnceWith(serializeCase(parsed.bundle));
    } else {
      expect(writeText.mock.calls.length).toBe(0);
    }
  } finally {
    try {
      act(() => root.unmount());
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }
});

test('round-trips a verified demo case as a shared replay', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new BatonApiClient('', fetchImpl);
  const title = 'Demo case round-trip';
  const exported = await client.exportRunCase('demo-run', { title });
  const checklist = checklistRows(exported.redaction_report, 'en');
  expect(checklist.verifiedClean).toBe(true);
  expect(checklist.rows.map(({ count }) => count)).toEqual([0, 0, 0, 0, 0, 0]);

  const detected = detectTransferInput(serializeCase(exported));
  assert(detected.kind === 'case', 'Expected a case after re-importing the demo export');
  expect(parseAndValidateCaseBundle(detected.bundle)).toStrictEqual({
    ok: true,
    bundle: { ...exported, title, isOfficialTutorial: false },
    warnings: [],
  });
  expect(exported.isOfficialTutorial).toBe(true);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('shows the case badge and replay details for the golden fixture', () => {
  const detected = detectTransferInput(JSON.stringify(goldenCase));
  expect(importPreview.buildImportPreview(detected, 'en')).toMatchObject({
    typeBadge: 'case',
    name: goldenCase.title,
    validationOk: true,
    redactionClean: true,
    durationLabel: '9.0s',
    taskSummary: '1/1',
  });
});

test('exposes the overwrite warning key before confirming an import on a dirty canvas', () => {
  const detected = detectTransferInput(serializeRecipe(flagship_4tier));
  expect(importPreview.buildImportPreview(detected, 'en', true).overwriteWarningKey)
    .toBe('transfer.importModal.overwriteWarning');
  expect(importPreview.buildImportPreview(detected, 'en', false).overwriteWarningKey).toBeUndefined();
});

const modalSources = [
  ['ImportTransferModal', importTransferSource],
  ['ExportRecipeModal', exportRecipeSource],
  ['ExportCaseModal', exportCaseSource],
] as const;

test.each(modalSources)('%s uses transfer keys defined in both locales', (_name, source) => {
  const keys = new Set(source.match(/\btransfer\.[a-zA-Z.]+/g));
  // Follow local aliases to check message fields as well as their section names.
  for (const [, alias, section] of source.matchAll(/\bconst\s+(\w+)\s*=\s*messages\.(transfer\.[a-zA-Z.]+);/g)) {
    for (const [, field] of source.matchAll(new RegExp('\\b' + alias + '\\.([a-zA-Z]+)\\b', 'g'))) {
      keys.add(section + '.' + field);
    }
  }
  expect([...keys].some((key) => key.split('.').length > 2)).toBe(true);

  for (const locale of ['en', 'zh'] as const) {
    for (const key of keys) {
      let value: unknown = MESSAGES[locale];
      for (const segment of key.split('.')) {
        value = value !== null && typeof value === 'object' && Object.hasOwn(value, segment)
          ? (value as Record<string, unknown>)[segment]
          : undefined;
      }
      expect(value, locale + '.' + key).toBeDefined();
    }
  }
});

test('accepts the Python golden case bundle in the replay parser', async () => {
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: URL, encoding: 'utf8'): string;
  }>('node:fs');
  const fixture = new URL('../../../tests/fixtures/golden_case_bundle.json', import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(fixture, 'utf8'));

  expect(parseAndValidateCaseBundle(raw)).toMatchObject({
    ok: true,
    bundle: { redaction_report: { clean: true } },
    warnings: [],
  });
});
