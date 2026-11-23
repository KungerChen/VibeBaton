import { act, Children, createElement, isValidElement } from 'react';
import type { ChangeEvent, ComponentProps, DragEvent, MouseEvent, ReactElement, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flagship_4tier } from '../../data/presets/flagship_4tier';
import goldenCase from '../../engine/__fixtures__/goldenCase.json';
import { detectTransferInput } from '../../engine/caseReplay';
import { buildShareUrl } from '../../engine/shareUrl';
import { MESSAGES } from '../../i18n/messages';
import { Button, type ButtonProps } from '../ui/button';
import { Textarea } from '../ui/input';
import { Modal } from '../ui/Modal';
import { ImportTransferModal, type ImportTransferModalProps } from './ImportTransferModal';
import { buildImportPreview } from './importPreview';

vi.mock('../ui/Modal', () => ({ Modal: vi.fn(() => null) }));

const recipeJson = JSON.stringify(flagship_4tier);
const caseJson = JSON.stringify(goldenCase);

describe('buildImportPreview', () => {
  test('previews the golden run case with its replay metrics and redaction health', () => {
    const result = detectTransferInput(caseJson);
    expect(buildImportPreview(result, 'en')).toEqual({
      typeBadge: 'case',
      name: 'Sanitized Run Case',
      nodeCount: 4,
      edgeCount: 3,
      validationOk: true,
      validationErrors: [],
      redactionClean: true,
      durationLabel: '9.0s',
      taskSummary: '1/1',
      warnings: [],
    });
    expect(buildImportPreview(result, 'zh').durationLabel).toBe('9.0秒');
  });

  test('keeps a case with a redaction warning eligible for replay', () => {
    const result = detectTransferInput(JSON.stringify({
      ...goldenCase,
      redaction_report: { ...goldenCase.redaction_report, clean: false },
    }));
    expect(buildImportPreview(result, 'en')).toMatchObject({
      typeBadge: 'case',
      validationOk: true,
      redactionClean: false,
    });
  });

  test('previews a flagship recipe JSON', () => {
    expect(buildImportPreview(detectTransferInput(recipeJson), 'en')).toEqual({
      typeBadge: 'recipe',
      name: 'Flagship 4-Tier Factory',
      nodeCount: 10,
      edgeCount: 13,
      validationOk: true,
      validationErrors: [],
      warnings: [],
    });
  });

  test('shows detector errors for invalid inputs', () => {
    const result = detectTransferInput(JSON.stringify({ ...goldenCase, trace: [] }));
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') throw new Error('Expected an invalid result');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(buildImportPreview(result, 'en')).toMatchObject({
      validationOk: false,
      validationErrors: result.errors,
    });
  });

  test('detects a #recipe= share URL as the same recipe', () => {
    const url = buildShareUrl(flagship_4tier, 'https://vibebaton.example/studio');
    const result = detectTransferInput(url);
    expect(result.kind).toBe('recipe');
    expect(buildImportPreview(result, 'en')).toEqual(buildImportPreview(detectTransferInput(recipeJson), 'en'));
  });
});

function elements(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<{ children?: ReactNode }>(child)
    ? [child, ...elements(child.props.children)]
    : []);
}

describe('ImportTransferModal', () => {
  const modal = vi.mocked(Modal);
  const copy = MESSAGES.en.transfer.importModal;
  let root: Root | undefined;

  beforeEach(() => {
    modal.mockClear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
  });

  afterEach(() => {
    try {
      act(() => root?.unmount());
    } finally {
      root = undefined;
      vi.unstubAllGlobals();
    }
  });

  async function mount(canvasDirty = false) {
    // The mocked dialog host captures the real input and confirm props in the node runner.
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    const renderer = createRoot(container as unknown as HTMLElement);
    root = renderer;
    const callbacks = {
      onClose: vi.fn<ImportTransferModalProps['onClose']>(),
      onApplyRecipe: vi.fn<ImportTransferModalProps['onApplyRecipe']>(),
      onLoadCase: vi.fn<ImportTransferModalProps['onLoadCase']>(),
    };
    await act(async () => renderer.render(createElement(ImportTransferModal, {
      open: true,
      canvasDirty,
      ...callbacks,
    })));
    return callbacks;
  }

  function modalContent() {
    const props = modal.mock.lastCall?.[0];
    if (!props) throw new Error('Expected an open import modal');
    return props.children;
  }

  async function paste(value: string) {
    const field = elements(modalContent()).find((element) => element.type === Textarea);
    const onChange = (field?.props as ComponentProps<typeof Textarea> | undefined)?.onChange;
    if (!onChange) throw new Error('Expected a paste field');
    await act(async () => onChange({ currentTarget: { value } } as ChangeEvent<HTMLTextAreaElement>));
  }

  function button(label: string) {
    const match = elements(modalContent()).find((element) => element.type === Button
      && Children.toArray(element.props.children).includes(label));
    if (!match) throw new Error(`Expected button: ${label}`);
    return match.props as ButtonProps;
  }

  async function confirm(label: string) {
    const { disabled, onClick } = button(label);
    expect(disabled).toBe(false);
    await act(async () => onClick?.({} as MouseEvent<HTMLButtonElement>));
  }

  async function drop(...files: File[]) {
    const target = button(copy.dropHint);
    const preventDefault = vi.fn();
    const event = { preventDefault, dataTransfer: { files, dropEffect: 'none' } };
    const dragEvent = event as unknown as DragEvent<HTMLButtonElement>;
    await act(async () => {
      target.onDragOver?.(dragEvent);
      target.onDrop?.(dragEvent);
    });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(event.dataTransfer.dropEffect).toBe('copy');
  }

  test('disables confirmation when valid pasted text becomes invalid', async () => {
    const { onApplyRecipe, onLoadCase } = await mount(true);
    await paste(recipeJson);
    expect(button(copy.applyRecipe).disabled).toBe(false);

    await paste('{');
    expect(button(copy.applyRecipe).disabled).toBe(true);
    const markup = renderToStaticMarkup(modalContent());
    expect(markup).toContain(copy.validationFail);
    expect(markup).toContain(copy.overwriteWarning);
    expect(onApplyRecipe).not.toHaveBeenCalled();
    expect(onLoadCase).not.toHaveBeenCalled();
  });

  test('previews a picked case and loads it only on confirm', async () => {
    const { onApplyRecipe, onLoadCase, onClose } = await mount();
    const picker = elements(modalContent()).find((element) => element.type === 'input');
    const props = picker?.props as ComponentProps<'input'> | undefined;
    expect(props).toMatchObject({ type: 'file', hidden: true, accept: '.json,.baton.json,.baton-case.json' });
    const file = new File([caseJson], 'golden.baton-case.json');
    const input = { files: [file], value: file.name };
    await act(async () => props?.onChange?.({ currentTarget: input } as unknown as ChangeEvent<HTMLInputElement>));
    expect(input.value).toBe('');

    const markup = renderToStaticMarkup(modalContent());
    expect(markup).toContain(goldenCase.title);
    expect(markup).toContain(copy.redactionClean);
    expect(markup).not.toContain(copy.overwriteWarning);
    expect(onLoadCase).not.toHaveBeenCalled();
    const detected = detectTransferInput(caseJson);
    if (detected.kind !== 'case') throw new Error('Expected a case');
    await confirm(copy.loadCase);
    expect(onLoadCase).toHaveBeenCalledExactlyOnceWith(detected.bundle);
    expect(onApplyRecipe).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('previews the first dropped file and applies the recipe on confirm', async () => {
    const { onApplyRecipe, onLoadCase, onClose } = await mount();
    await drop(new File([recipeJson], 'first.baton.json'), new File([caseJson], 'second.baton-case.json'));
    expect(renderToStaticMarkup(modalContent())).toContain(copy.detectRecipe);
    expect(onApplyRecipe).not.toHaveBeenCalled();
    await confirm(copy.applyRecipe);
    expect(onApplyRecipe).toHaveBeenCalledExactlyOnceWith(flagship_4tier);
    expect(onLoadCase).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('ignores an earlier file read that finishes after a newer paste', async () => {
    await mount();
    await paste(recipeJson);
    let finishRead!: (value: string) => void;
    const file = new File([caseJson], 'slow.baton-case.json');
    vi.spyOn(file, 'text').mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
    await drop(file);
    expect(button(copy.applyRecipe).disabled).toBe(true);
    await paste(recipeJson);
    await act(async () => finishRead(caseJson));
    expect(button(copy.applyRecipe).disabled).toBe(false);
  });
});
