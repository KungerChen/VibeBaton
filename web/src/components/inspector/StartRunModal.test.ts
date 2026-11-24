import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type BatonApiClient } from '../../api/client';
import { I18nProvider } from '../../i18n';
import { MESSAGES } from '../../i18n/messages';
import { StartRunModal } from './StartRunModal';

function createDialogHarness() {
  type Listener = (event: Record<string, unknown>) => void;
  const listeners = new Map<string, Listener>();
  const documentObj = {
    createElement: (tag: string) => new TestNode(tag),
    createElementNS: (_ns: string, tag: string) => new TestNode(tag),
    createTextNode: (text: string) => new TestNode('#text', text),
    addEventListener() {},
  };

  class TestNode {
    readonly nodeType: number;
    readonly ownerDocument = documentObj;
    readonly children: TestNode[] = [];
    readonly style = {};
    readonly attrs = new Map<string, string>();
    parentNode: TestNode | null = null;
    open = false;
    private _value = '';
    scrollTop = 0;
    disabled = false;

    constructor(readonly tagName: string, public textContent = '') {
      this.nodeType = tagName === '#text' ? 3 : 1;
    }
    get value(): string { return this._value; }
    set value(v: string) { this._value = String(v); }
    addEventListener(type: string, cb: Listener, capture: boolean) {
      if (!capture) listeners.set(type, cb);
    }
    setAttribute(k: string, v: string) { this.attrs.set(k, v); }
    removeAttribute(k: string) { this.attrs.delete(k); }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    appendChild(c: TestNode) { this.insertBefore(c, null); }
    insertBefore(c: TestNode, s: TestNode | null) {
      const idx = s ? this.children.indexOf(s) : this.children.length;
      this.children.splice(idx, 0, c);
      c.parentNode = this;
    }
    removeChild(c: TestNode) {
      this.children.splice(this.children.indexOf(c), 1);
      c.parentNode = null;
    }
    get nodeName(): string { return this.tagName.toUpperCase(); }
    get text(): string { return this.textContent + this.children.map((c) => c.text).join(''); }
    get options(): TestNode[] { return this.findAll('option'); }
    find(tag: string, pred?: (n: TestNode) => boolean): TestNode | undefined {
      if (this.tagName === tag && (!pred || pred(this))) return this;
      for (const c of this.children) {
        const m = c.find(tag, pred);
        if (m) return m;
      }
      return undefined;
    }
    findAll(tag: string, pred?: (n: TestNode) => boolean): TestNode[] {
      const out: TestNode[] = [];
      if (this.tagName === tag && (!pred || pred(this))) out.push(this);
      for (const c of this.children) out.push(...c.findAll(tag, pred));
      return out;
    }
  }

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    HTMLIFrameElement: class HTMLIFrameElement {},
    localStorage: { getItem: () => 'en' },
  });

  const container = new TestNode('DIV');
  return {
    container,
    click(target: TestNode) {
      const listener = listeners.get('click');
      if (!listener) throw new Error('Missing click listener');
      listener({ type: 'click', target, button: 0 });
    },
    input(target: TestNode, value: string) {
      target.value = value;
      const propsKey = Object.keys(target).find((key) => key.startsWith('__reactProps$'));
      const reactProps = propsKey
        ? (target as unknown as Record<string, { onChange?: (e: { currentTarget: TestNode; target: TestNode }) => void }>)[propsKey]
        : undefined;
      if (reactProps?.onChange) {
        reactProps.onChange({ currentTarget: target, target });
        return;
      }
      const listener = listeners.get('input') ?? listeners.get('change');
      if (!listener) throw new Error('Missing input/change listener');
      listener({ type: 'input', target });
    },
    submit(target: TestNode) {
      const listener = listeners.get('submit');
      if (!listener) throw new Error('Missing submit listener');
      listener({ type: 'submit', target, preventDefault: () => {} });
    },
  };
}

describe('StartRunModal timeout and error recovery', () => {
  let root: Root | undefined;

  afterEach(() => {
    try {
      act(() => root?.unmount());
    } finally {
      root = undefined;
      vi.unstubAllGlobals();
    }
  });

  function createMockClient(startRun: BatonApiClient['startRun']): BatonApiClient {
    return {
      mode: 'local',
      health: { status: 'ok' },
      listPresets: vi.fn().mockResolvedValue([]),
      getRolesConfig: vi.fn().mockResolvedValue({
        config_path: '.baton/baton.toml',
        budget_profile: 'balanced',
        providers: {},
        roles: {},
        model_catalog: [],
      }),
      listCredentials: vi.fn().mockResolvedValue([]),
      checkRfc: vi.fn().mockResolvedValue({
        score: 100,
        safe_for_overnight: true,
        missing_sections: [],
        warnings: [],
        detected_commands: ['pytest'],
      }),
      startRun,
    } as unknown as BatonApiClient;
  }

  async function mountAndAdvanceToLaunch(client: BatonApiClient) {
    const harness = createDialogHarness();
    const onClose = vi.fn();
    const onStarted = vi.fn();
    const onToast = vi.fn();
    root = createRoot(harness.container as unknown as HTMLElement);

    await act(async () => {
      root!.render(createElement(I18nProvider, {
        children: createElement(StartRunModal, { client, onClose, onStarted, onToast }),
      }));
    });

    // Preflight -> Brainstorm
    const nextBtn = harness.container.find('button', (n) => n.text.includes('Next'));
    expect(nextBtn).toBeDefined();
    await act(async () => harness.click(nextBtn!));

    // Fill RFC markdown textarea (last textarea in RfcStep is the markdown editor)
    const rfcMarkdown = '## Goal\nBuild a safe feature with complete verification.\n';
    const textareas = harness.container.findAll('textarea');
    const markdownArea = textareas.at(-1);
    expect(markdownArea).toBeDefined();
    await act(async () => harness.input(markdownArea!, rfcMarkdown));

    // Advance from Brainstorm -> Launch via Skip Brainstorm (+ confirm skip warning if RFC is partial)
    const skipBtn = harness.container.find('button', (n) => n.text === MESSAGES.en.wizard.skipBrainstorm);
    expect(skipBtn).toBeDefined();
    await act(async () => harness.click(skipBtn!));
    const confirmSkipBtn = harness.container.find('button', (n) => n.text === MESSAGES.en.wizard.skipWarning.confirm);
    if (confirmSkipBtn) {
      await act(async () => harness.click(confirmSkipBtn));
    }

    return { harness, rfcMarkdown, onClose, onStarted, onToast };
  }

  test('unlocks modal, preserves RFC, and displays timeout alert when startRun times out', async () => {
    const startRun = vi.fn().mockRejectedValueOnce(new ApiError(408, 'Request timed out'));
    const client = createMockClient(startRun);
    const { harness, rfcMarkdown, onClose, onStarted } = await mountAndAdvanceToLaunch(client);

    const launchForm = harness.container.find('form', (n) => Boolean(n.attrs.get('id')?.endsWith('-start')));
    expect(launchForm).toBeDefined();
    await act(async () => harness.submit(launchForm!));

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ rfc_markdown: rfcMarkdown }));
    expect(onStarted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const alert = harness.container.find('p', (n) => n.attrs.get('role') === 'alert');
    expect(alert?.text).toBe(MESSAGES.en.inspector.startTimeoutError);

    // Close button must be unlocked and clickable.
    const closeBtn = harness.container.find('button', (n) => n.attrs.get('aria-label') === MESSAGES.en.inspector.modalCloseAria);
    expect(closeBtn).toBeDefined();
    expect(closeBtn?.disabled).toBeFalsy();
    await act(async () => harness.click(closeBtn!));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('renders real error.message inline inside role="alert" when startRun fails', async () => {
    const startRun = vi.fn().mockRejectedValueOnce(new ApiError(400, 'Worktree has uncommitted changes'));
    const client = createMockClient(startRun);
    const { harness } = await mountAndAdvanceToLaunch(client);

    const launchForm = harness.container.find('form', (n) => Boolean(n.attrs.get('id')?.endsWith('-start')));
    expect(launchForm).toBeDefined();
    await act(async () => harness.submit(launchForm!));

    const alert = harness.container.find('p', (n) => n.attrs.get('role') === 'alert');
    expect(alert?.text).toContain('Worktree has uncommitted changes');
  });
});
