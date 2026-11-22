import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLiquidThemeController } from './LiquidThemeEngine';
import type { LiquidAudioAdapter, LiquidStage } from './types';

class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = { cssText: '' };
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  scrollTop = 0;
  scrollLeft = 0;
  inert = false;
  tabIndex = 0;

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== '*') return [];
    const result: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        result.push(child);
        walk(child);
      }
    };
    walk(this);
    return result;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 };
  }

  cloneNode(deep = false): FakeElement {
    const copy = new FakeElement(this.tagName);
    for (const [k, v] of this.attributes) {
      copy.attributes.set(k, v);
    }
    Object.assign(copy.dataset, this.dataset);
    Object.assign(copy.style, this.style);
    if (deep) {
      for (const child of this.children) {
        const clonedChild = child.cloneNode(true);
        clonedChild.parentNode = copy;
        copy.children.push(clonedChild);
      }
    }
    return copy;
  }
}

class FakeHTMLInputElement extends FakeElement {}
class FakeHTMLTextAreaElement extends FakeElement {}
class FakeHTMLSelectElement extends FakeElement {}
class FakeHTMLMediaElement extends FakeElement {}
class FakeSVGClipPathElement extends FakeElement {}

function makeAudioSpy(): LiquidAudioAdapter & {
  stages: LiquidStage[];
  progressCalls: number;
  completeCount: number;
  interruptCount: number;
  reducedCueCount: number;
} {
  const spy = {
    stages: [] as LiquidStage[],
    progressCalls: 0,
    completeCount: 0,
    interruptCount: 0,
    reducedCueCount: 0,
    unlock: vi.fn(),
    onStage: vi.fn((stage: LiquidStage) => {
      spy.stages.push(stage);
    }),
    onProgress: vi.fn(() => {
      spy.progressCalls += 1;
    }),
    onComplete: vi.fn(() => {
      spy.completeCount += 1;
    }),
    onInterrupt: vi.fn(() => {
      spy.interruptCount += 1;
    }),
    playReducedMotionCue: vi.fn(() => {
      spy.reducedCueCount += 1;
    }),
    setEnabled: vi.fn(),
    setVolume: vi.fn(),
    dispose: vi.fn(),
  };
  return spy;
}

const savedGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  CSS: globalThis.CSS,
  HTMLElement: globalThis.HTMLElement,
  HTMLInputElement: globalThis.HTMLInputElement,
  HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
  HTMLSelectElement: globalThis.HTMLSelectElement,
  HTMLMediaElement: globalThis.HTMLMediaElement,
  SVGClipPathElement: globalThis.SVGClipPathElement,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};

function setupMockDom(opts: { reducedMotion: boolean; svgClipSupported: boolean }) {
  const body = new FakeElement('body');
  const root = new FakeElement('div');
  root.setAttribute('id', 'root');

  const panel = new FakeElement('div');
  panel.setAttribute('id', 'scroll-pane');
  panel.scrollTop = 120;
  panel.setAttribute('clip-path', 'url(#scroll-pane)');

  const label = new FakeElement('label');
  label.setAttribute('for', 'scroll-pane');

  root.append(panel, label);
  body.append(root);

  const windowListeners = new Map<string, Set<() => void>>();
  const docListeners = new Map<string, Set<() => void>>();
  const rafQueue = new Map<number, FrameRequestCallback>();
  let nextRafId = 1;

  const mockDocument = {
    visibilityState: 'visible' as DocumentVisibilityState,
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    body,
    getElementById: (id: string) => (id === 'root' ? root : null),
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    addEventListener: (type: string, fn: () => void) => {
      const set = docListeners.get(type) ?? new Set();
      set.add(fn);
      docListeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      docListeners.get(type)?.delete(fn);
    },
  };

  const mockWindow = {
    innerWidth: 1280,
    innerHeight: 720,
    matchMedia: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? opts.reducedMotion : false,
    }),
    addEventListener: (type: string, fn: () => void) => {
      const set = windowListeners.get(type) ?? new Set();
      set.add(fn);
      windowListeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      windowListeners.get(type)?.delete(fn);
    },
  };

  Object.assign(globalThis, {
    window: mockWindow,
    document: mockDocument,
    CSS: { supports: () => opts.svgClipSupported },
    HTMLElement: FakeElement,
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    HTMLSelectElement: FakeHTMLSelectElement,
    HTMLMediaElement: FakeHTMLMediaElement,
    SVGClipPathElement: opts.svgClipSupported ? FakeSVGClipPathElement : undefined,
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      rafQueue.delete(id);
    },
  });

  const flushFrame = (nowMs: number) => {
    const batch = Array.from(rafQueue.entries());
    rafQueue.clear();
    for (const [, cb] of batch) {
      cb(nowMs);
    }
  };

  const emitVisibilityHidden = () => {
    mockDocument.visibilityState = 'hidden';
    for (const fn of docListeners.get('visibilitychange') ?? []) fn();
  };

  return { body, root, rafQueue, flushFrame, emitVisibilityHidden };
}

afterEach(() => {
  Object.assign(globalThis, savedGlobals);
});

describe('createLiquidThemeController', () => {
  test('respects prefers-reduced-motion by committing immediately without rAF or overlay', () => {
    const env = setupMockDom({ reducedMotion: true, svgClipSupported: true });
    const audio = makeAudioSpy();
    const committed: string[] = [];

    const controller = createLiquidThemeController({
      durationMs: 1000,
      audio,
      onCommitTheme: (next) => committed.push(next),
    });

    controller.trigger('dark', 'light', { x: 1100, y: 24 });

    expect(committed).toEqual(['light']);
    expect(controller.isAnimating()).toBe(false);
    expect(env.rafQueue.size).toBe(0);
    expect(env.body.children).toHaveLength(1);
    expect(audio.reducedCueCount).toBe(1);
    expect(audio.completeCount).toBe(0);
  });

  test('allows explicit opt-out via respectReducedMotion: false for previewing', () => {
    const env = setupMockDom({ reducedMotion: true, svgClipSupported: true });
    const audio = makeAudioSpy();
    const committed: string[] = [];

    const controller = createLiquidThemeController({
      durationMs: 1000,
      respectReducedMotion: false,
      audio,
      onCommitTheme: (next) => committed.push(next),
    });

    controller.trigger('dark', 'light', { x: 1100, y: 24 });

    expect(controller.isAnimating()).toBe(true);
    expect(committed).toEqual([]);
    expect(env.body.children).toHaveLength(3);
    expect(audio.reducedCueCount).toBe(0);
    controller.dispose();
  });

  test('falls back cleanly when SVG clipPath is unsupported', () => {
    const env = setupMockDom({ reducedMotion: false, svgClipSupported: false });
    const audio = makeAudioSpy();
    const committed: string[] = [];

    const controller = createLiquidThemeController({
      durationMs: 1000,
      audio,
      onCommitTheme: (next) => committed.push(next),
    });

    controller.trigger('dark', 'light');

    expect(committed).toEqual(['light']);
    expect(controller.isAnimating()).toBe(false);
    expect(env.rafQueue.size).toBe(0);
    expect(env.body.children).toHaveLength(1);
  });

  test('runs full 4-stage SVG clipPath animation lifecycle and cleans up overlay', () => {
    const env = setupMockDom({ reducedMotion: false, svgClipSupported: true });
    const audio = makeAudioSpy();
    const committed: string[] = [];

    const controller = createLiquidThemeController({
      durationMs: 1000,
      respectReducedMotion: false,
      audio,
      onCommitTheme: (next) => committed.push(next),
    });

    controller.trigger('dark', 'light', { x: 1120, y: 28 });

    expect(controller.isAnimating()).toBe(true);
    expect(env.body.children).toHaveLength(3); // root + overlay + svg

    const overlay = env.body.children[1];
    const svg = env.body.children[2];
    expect(overlay.dataset.liquidRevealOverlay).toBe('true');
    expect(overlay.dataset.theme).toBe('light');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.inert).toBe(true);
    expect(overlay.tabIndex).toBe(-1);

    const cloneFrame = overlay.children[0];
    const cloneRoot = cloneFrame.children[0];
    expect(cloneRoot.style.width).toBe('100%');
    expect(cloneRoot.style.height).toBe('100%');
    expect(cloneRoot.getAttribute('id')).not.toBe('root');
    expect(cloneRoot.children[0].scrollTop).toBe(120);
    expect(cloneRoot.children[1].getAttribute('for')).toBe(cloneRoot.children[0].getAttribute('id'));
    expect(cloneRoot.children[0].getAttribute('clip-path')).toBe(
      `url(#${cloneRoot.children[0].getAttribute('id')})`,
    );

    const defs = svg.children[0];
    const clipPath = defs.children[0];
    const clipPathEl = clipPath.children[0];
    expect(svg.dataset.liquidRevealSvg).toBe('true');
    expect(clipPath.getAttribute('clipPathUnits')).toBe('userSpaceOnUse');

    const initialD = clipPathEl.getAttribute('d');
    expect(initialD).toBe('');

    // Step across pour -> splash -> rise -> complete timestamps.
    env.flushFrame(1000); // startTimestamp = 1000, progress = 0 (pour stage enters)
    env.flushFrame(1100); // progress = 0.10 (active pour column)
    const pourD = clipPathEl.getAttribute('d');
    expect(pourD?.startsWith('M')).toBe(true);

    env.flushFrame(1270); // progress = 0.27 (splash)
    env.flushFrame(1600); // progress = 0.60 (rise)
    const midD = clipPathEl.getAttribute('d');
    expect(midD?.startsWith('M')).toBe(true);
    expect(midD).not.toBe(pourD);
    expect(committed).toEqual([]);

    env.flushFrame(2000); // progress = 1.00 (complete + commit, keeps overlay 1 frame)
    expect(audio.stages).toEqual(['pour', 'splash', 'rise', 'complete']);
    expect(audio.progressCalls).toBe(1);
    expect(audio.completeCount).toBe(1);
    expect(audio.interruptCount).toBe(0);
    expect(committed).toEqual(['light']);
    expect(env.rafQueue.size).toBe(1); // postCommit cleanup rAF

    env.flushFrame(2016); // post-commit cleanup
    expect(controller.isAnimating()).toBe(false);
    expect(env.body.children).toHaveLength(1);
  });

  test('interrupts cleanly on visibility hide without firing false completion audio', () => {
    const env = setupMockDom({ reducedMotion: false, svgClipSupported: true });
    const audio = makeAudioSpy();
    const committed: string[] = [];

    const controller = createLiquidThemeController({
      durationMs: 1000,
      audio,
      onCommitTheme: (next) => committed.push(next),
    });

    controller.trigger('light', 'dark', { x: 1080, y: 24 });
    env.flushFrame(100); // pour
    env.flushFrame(600); // rise

    expect(controller.isAnimating()).toBe(true);
    env.emitVisibilityHidden();

    expect(controller.isAnimating()).toBe(false);
    expect(env.rafQueue.size).toBe(0);
    expect(env.body.children).toHaveLength(1);
    expect(audio.interruptCount).toBe(1);
    expect(audio.completeCount).toBe(0);
    expect(committed).toEqual(['dark']);

    controller.dispose();
    expect(audio.dispose).toHaveBeenCalledTimes(1);
  });

  test('cancels in-flight transition without completion chime on interrupt(false) or rapid re-trigger', () => {
    const env = setupMockDom({ reducedMotion: false, svgClipSupported: true });
    const audio = makeAudioSpy();
    const committed: string[] = [];

    const controller = createLiquidThemeController({
      durationMs: 1000,
      audio,
      onCommitTheme: (next) => committed.push(next),
    });

    controller.trigger('dark', 'light', { x: 1080, y: 24 });
    env.flushFrame(100);
    env.flushFrame(500);

    // Rapid re-trigger mid-flight cancels prior transition without false completion sound.
    controller.trigger('light', 'dark', { x: 1080, y: 24 });
    expect(audio.interruptCount).toBe(1);
    expect(audio.completeCount).toBe(0);
    expect(committed).toEqual([]);
    expect(env.body.children).toHaveLength(3);

    controller.interrupt(false);
    expect(controller.isAnimating()).toBe(false);
    expect(env.rafQueue.size).toBe(0);
    expect(env.body.children).toHaveLength(1);
    expect(audio.interruptCount).toBe(2);
    expect(audio.completeCount).toBe(0);
  });
});
