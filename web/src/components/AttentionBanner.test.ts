import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { MESSAGES } from '../i18n/messages';
import type { AttentionCategory, RunAttentionState } from '../types/graph';
import {
  AttentionBanner,
  attentionActionsFor,
  attentionBadgeLabel,
  type AttentionBannerProps,
} from './AttentionBanner';

const RUN_ID = 'run-20261121-044454-3b1845';

const baseAlert: RunAttentionState = {
  category: 'waiting_human',
  severity: 'warning',
  title: 'Server-provided title',
  message: 'Task M1-T1 exhausted its merge attempts.',
  action_hint: 'Review and resolve the blocker in Studio.',
  milestone_id: 'M1',
  task_id: 'M1-T1',
  created_at: 120.125,
};

const noop = () => {};

function render(overrides: Partial<AttentionBannerProps> = {}): string {
  return renderToStaticMarkup(createElement(AttentionBanner, {
    alert: baseAlert,
    runId: RUN_ID,
    locale: 'en',
    notificationPermission: 'default',
    onApprove: noop,
    onReject: noop,
    onResume: noop,
    onOpenBattleReport: noop,
    onEnableNotifications: noop,
    onDismiss: noop,
    ...overrides,
  }));
}

function alertFor(category: AttentionCategory, severity: RunAttentionState['severity']) {
  return { ...baseAlert, category, severity, message: `${category} detail` };
}

describe('attentionActionsFor', () => {
  test('returns the exact actions for each category', () => {
    expect(attentionActionsFor('waiting_human')).toEqual(['approve', 'reject']);
    expect(attentionActionsFor('paused')).toEqual(['resume']);
    expect(attentionActionsFor('ready_for_final_gate')).toEqual(['battle_report']);
    expect(attentionActionsFor('failed')).toEqual([]);
    expect(attentionActionsFor('long_cooldown')).toEqual([]);
  });

  test('returns a fresh list that cannot corrupt later calls', () => {
    const actions = attentionActionsFor('waiting_human');
    actions.push('resume');

    expect(attentionActionsFor('waiting_human')).toEqual(['approve', 'reject']);
  });
});

describe('attentionBadgeLabel', () => {
  const categories: AttentionCategory[] = [
    'waiting_human',
    'ready_for_final_gate',
    'failed',
    'paused',
    'long_cooldown',
  ];

  test('localizes every category in en and zh', () => {
    for (const category of categories) {
      expect(attentionBadgeLabel(category, 'en')).toBe(MESSAGES.en.attention.badges[category]);
      expect(attentionBadgeLabel(category, 'zh')).toBe(MESSAGES.zh.attention.badges[category]);
    }
  });

  test('keeps the English labels pure ASCII and the Chinese labels Han', () => {
    for (const category of categories) {
      expect(attentionBadgeLabel(category, 'en')).toMatch(/^[\x20-\x7E]+$/);
      expect(attentionBadgeLabel(category, 'zh')).toMatch(/\p{Script=Han}/u);
    }
  });
});

describe('AttentionBanner', () => {
  test('renders an empty string without an alert', () => {
    expect(render({ alert: null })).toBe('');
  });

  test('renders the section, localized title, run id, and waiting-human actions', () => {
    const markup = render();

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain(
      'class="attention-banner attention-banner--warning attention-banner--waiting_human"',
    );
    expect(markup).toContain(
      'class="attention-banner__badge" data-category="waiting_human"',
    );
    expect(markup).toContain(MESSAGES.en.attention.waitingHuman);
    expect(markup).toContain(MESSAGES.en.attention.badges.waiting_human);
    expect(markup).toContain('class="attention-banner__run"');
    expect(markup).toContain(`>${RUN_ID}</code>`);
    expect(markup).toContain(`>${MESSAGES.en.attention.approve}</button>`);
    expect(markup).toContain(`>${MESSAGES.en.attention.reject}</button>`);
    expect(markup).not.toContain(MESSAGES.en.attention.resume);
    expect(markup).not.toContain(MESSAGES.en.attention.viewBattleReport);
    expect(markup).not.toContain(baseAlert.title);
  });

  test('renders Resume only for a paused run', () => {
    const markup = render({ alert: alertFor('paused', 'warning') });

    expect(markup).toContain(MESSAGES.en.attention.paused);
    expect(markup).toContain(`>${MESSAGES.en.attention.resume}</button>`);
    expect(markup).not.toContain(`>${MESSAGES.en.attention.approve}</button>`);
    expect(markup).not.toContain(`>${MESSAGES.en.attention.reject}</button>`);
    expect(markup).not.toContain(MESSAGES.en.attention.viewBattleReport);
  });

  test('renders the battle report action only for the final gate', () => {
    const markup = render({ alert: alertFor('ready_for_final_gate', 'info') });

    expect(markup).toContain('attention-banner--info');
    expect(markup).toContain(MESSAGES.en.attention.readyForFinalGate);
    expect(markup).toContain(`>${MESSAGES.en.attention.viewBattleReport}</button>`);
    expect(markup).not.toContain(`>${MESSAGES.en.attention.resume}</button>`);
    expect(markup).not.toContain(`>${MESSAGES.en.attention.approve}</button>`);
    expect(markup).not.toContain(`>${MESSAGES.en.attention.reject}</button>`);
  });

  test.each([
    ['warning', 'warning'],
    ['error', 'error'],
    ['info', 'info'],
  ] as const)('maps severity %s to its banner modifier', (severity, modifier) => {
    expect(render({ alert: alertFor('failed', severity) })).toContain(
      `attention-banner--${modifier}`,
    );
  });

  test('offers the desktop alerts call to action only while permission is default', () => {
    const withDefault = render({ notificationPermission: 'default' });
    expect(withDefault).toContain(MESSAGES.en.attention.enableDesktopAlerts);
    expect(withDefault).not.toContain(MESSAGES.en.attention.notificationsEnabled);
    expect(withDefault).not.toContain(MESSAGES.en.attention.notificationsBlocked);

    const granted = render({ notificationPermission: 'granted' });
    expect(granted).not.toContain(MESSAGES.en.attention.enableDesktopAlerts);
    expect(granted).toContain(MESSAGES.en.attention.notificationsEnabled);
    expect(granted).not.toContain(MESSAGES.en.attention.notificationsBlocked);

    const denied = render({ notificationPermission: 'denied' });
    expect(denied).not.toContain(MESSAGES.en.attention.enableDesktopAlerts);
    expect(denied).not.toContain(MESSAGES.en.attention.notificationsEnabled);
    expect(denied).toContain(MESSAGES.en.attention.notificationsBlocked);

    const unsupported = render({ notificationPermission: 'unsupported' });
    expect(unsupported).not.toContain(MESSAGES.en.attention.enableDesktopAlerts);
    expect(unsupported).not.toContain(MESSAGES.en.attention.notificationsEnabled);
    expect(unsupported).not.toContain(MESSAGES.en.attention.notificationsBlocked);
    expect(unsupported).toContain(`>${MESSAGES.en.attention.dismiss}</button>`);
  });

  test('renders zh copy from messages.attention', () => {
    const markup = render({ locale: 'zh', alert: alertFor('waiting_human', 'warning') });

    expect(markup).toContain(MESSAGES.zh.attention.waitingHuman);
    expect(markup).toContain(MESSAGES.zh.attention.badges.waiting_human);
    expect(markup).toContain(`>${MESSAGES.zh.attention.approve}</button>`);
    expect(markup).toContain(`>${MESSAGES.zh.attention.reject}</button>`);
    expect(markup).toContain(MESSAGES.zh.attention.enableDesktopAlerts);
    expect(markup).toContain(`>${MESSAGES.zh.attention.dismiss}</button>`);
    expect(markup).not.toContain(MESSAGES.en.attention.waitingHuman);
  });

  test('falls back to the localized detail when the alert message is blank', () => {
    const markup = render({ alert: { ...baseAlert, message: '   ' } });

    expect(markup).toContain(MESSAGES.en.attention.fallbackDetails.waiting_human);
  });

  test('omits the run code when no run id is available', () => {
    const markup = render({ runId: null });

    expect(markup).not.toContain('attention-banner__run');
  });

  test('disables approve, reject, and resume actions when controlsDisabled is true', () => {
    const waitingMarkup = render({ controlsDisabled: true });
    expect(waitingMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(waitingMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Reject<\/button>/);

    const pausedMarkup = render({ alert: alertFor('paused', 'warning'), controlsDisabled: true });
    expect(pausedMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Resume<\/button>/);
  });

  test('supports reversible Reject form with Cancel, Escape collapse, and Enter submit', async () => {
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
      parentNode: TestNode | null = null;
      value = '';
      constructor(readonly tagName: string, public textContent = '') {
        this.nodeType = tagName === '#text' ? 3 : 1;
      }
      addEventListener(type: string, cb: Listener, capture: boolean) {
        if (!capture) listeners.set(type, cb);
      }
      setAttribute() {}
      removeAttribute() {}
      focus() {}
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
      get text(): string { return this.textContent + this.children.map((c) => c.text).join(''); }
      find(tag: string, pred?: (n: TestNode) => boolean): TestNode | undefined {
        if (this.tagName === tag && (!pred || pred(this))) return this;
        for (const c of this.children) {
          const m = c.find(tag, pred);
          if (m) return m;
        }
        return undefined;
      }
    }

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
    const onReject = vi.fn();
    const container = new TestNode('DIV');
    const root = createRoot(container as unknown as HTMLElement);
    try {
      await act(async () => {
        root.render(createElement(AttentionBanner, {
          alert: baseAlert,
          runId: RUN_ID,
          locale: 'en',
          notificationPermission: 'default',
          onApprove: noop,
          onReject,
          onResume: noop,
          onOpenBattleReport: noop,
          onEnableNotifications: noop,
          onDismiss: noop,
        }));
      });

      // Open reject form
      const rejectTrigger = container.find('button', (n) => n.text === 'Reject');
      expect(rejectTrigger).toBeDefined();
      await act(async () => listeners.get('click')?.({ type: 'click', target: rejectTrigger, button: 0 }));
      expect(container.find('form')).toBeDefined();
      expect(container.find('button', (n) => n.text === 'Cancel')).toBeDefined();

      // Cancel collapses form without calling onReject
      const cancelBtn = container.find('button', (n) => n.text === 'Cancel');
      await act(async () => listeners.get('click')?.({ type: 'click', target: cancelBtn, button: 0 }));
      expect(container.find('form')).toBeUndefined();
      expect(onReject).not.toHaveBeenCalled();

      // Reopen and press Escape on input -> collapses without calling onReject
      const rejectTrigger2 = container.find('button', (n) => n.text === 'Reject');
      await act(async () => listeners.get('click')?.({ type: 'click', target: rejectTrigger2, button: 0 }));
      const inputEl = container.find('input');
      expect(inputEl).toBeDefined();
      await act(async () => listeners.get('keydown')?.({ type: 'keydown', target: inputEl, key: 'Escape', preventDefault: noop }));
      expect(container.find('form')).toBeUndefined();
      expect(onReject).not.toHaveBeenCalled();

      // Reopen and submit form -> calls onReject
      const rejectTrigger3 = container.find('button', (n) => n.text === 'Reject');
      await act(async () => listeners.get('click')?.({ type: 'click', target: rejectTrigger3, button: 0 }));
      const formEl = container.find('form');
      expect(formEl).toBeDefined();
      await act(async () => listeners.get('submit')?.({ type: 'submit', target: formEl, preventDefault: noop }));
      expect(onReject).toHaveBeenCalledOnce();
    } finally {
      try {
        act(() => root.unmount());
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});
