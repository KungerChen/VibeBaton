import { createRevealOverlay, supportsSvgClipPath, type LiquidOverlayHandle } from './domSnapshot';
import { computeLiquidFrame } from './liquidGeometry';
import type {
  LiquidDirection,
  LiquidOrigin,
  LiquidRevealOptions,
  LiquidStage,
  LiquidTheme,
  LiquidThemeController,
} from './types';

const DEFAULT_DURATION_MS = 1150;

let nextInstanceSeq = 0;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function resolveOriginCoords(origin: LiquidOrigin, width: number, height: number): { x: number; y: number } {
  const fallback = { x: Math.max(0, width - 140), y: 26 };
  if (!origin) return fallback;

  if (typeof origin === 'function') {
    const coords = origin();
    return coords ?? fallback;
  }

  if (typeof HTMLElement !== 'undefined' && origin instanceof HTMLElement) {
    const rect = origin.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return fallback;
    return {
      x: rect.left + rect.width / 2,
      y: Math.min(height - 2, rect.bottom - 2),
    };
  }

  if (typeof origin === 'object' && 'x' in origin && 'y' in origin) {
    return { x: origin.x, y: origin.y };
  }

  return fallback;
}

export function createLiquidThemeController(options: LiquidRevealOptions): LiquidThemeController {
  const durationMs = Math.max(200, options.durationMs ?? DEFAULT_DURATION_MS);
  let rafId: number | null = null;
  let postCommitRafId: number | null = null;
  let overlay: LiquidOverlayHandle | null = null;
  let activeTargetTheme: LiquidTheme | null = null;
  let activeDirection: LiquidDirection | null = null;
  let lastStage: LiquidStage | null = null;
  let listenersAttached = false;
  let disposed = false;

  const detachWindowListeners = () => {
    if (!listenersAttached || typeof window === 'undefined' || typeof document === 'undefined') return;
    listenersAttached = false;
    window.removeEventListener('resize', handleAbortEvent);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };

  const cleanupVisuals = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (postCommitRafId !== null) {
      cancelAnimationFrame(postCommitRafId);
      postCommitRafId = null;
    }
    detachWindowListeners();
    overlay?.destroy();
    overlay = null;
    activeTargetTheme = null;
    activeDirection = null;
    lastStage = null;
  };

  const interrupt = (commitTarget = false) => {
    const targetToCommit = activeTargetTheme;
    const wasAnimating = rafId !== null || postCommitRafId !== null || overlay !== null;
    cleanupVisuals();
    if (wasAnimating) {
      options.audio?.onInterrupt();
    }
    if (commitTarget && targetToCommit) {
      options.onCommitTheme(targetToCommit);
    }
  };

  function handleAbortEvent() {
    interrupt(true);
  }

  function handleVisibilityChange() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      interrupt(true);
    }
  }

  const trigger = (currentTheme: LiquidTheme, nextTheme: LiquidTheme, origin?: LiquidOrigin) => {
    if (disposed || currentTheme === nextTheme) return;

    const direction: LiquidDirection = nextTheme === 'dark' ? 'to-dark' : 'to-light';

    if (options.respectReducedMotion !== false && prefersReducedMotion()) {
      interrupt(false);
      void options.audio?.unlock();
      options.onCommitTheme(nextTheme);
      options.audio?.playReducedMotionCue(direction);
      return;
    }

    const sourceRoot = options.getSourceRoot?.() ?? document.getElementById('root') ?? document.body;
    const mountTarget = options.getMountTarget?.() ?? document.body;
    if (!sourceRoot || !mountTarget || !supportsSvgClipPath() || typeof requestAnimationFrame !== 'function') {
      interrupt(false);
      options.onCommitTheme(nextTheme);
      return;
    }

    // Cancel any previous in-flight transition cleanly without playing a false completion chime.
    interrupt(false);
    void options.audio?.unlock();

    const width = window.innerWidth || document.documentElement.clientWidth || 1280;
    const height = window.innerHeight || document.documentElement.clientHeight || 720;
    const { x: originX, y: originY } = resolveOriginCoords(origin, width, height);
    const clipId = `vibebaton-liquid-clip-${++nextInstanceSeq}`;

    overlay = createRevealOverlay(
      sourceRoot,
      mountTarget,
      nextTheme,
      clipId,
      options.prepareClone,
    );
    activeTargetTheme = nextTheme;
    activeDirection = direction;
    lastStage = null;

    // Emit initial frame before the first browser paint so progress=0 starts cleanly at the origin button.
    const initialFrame = computeLiquidFrame(originX, originY, width, height, 0);
    overlay.clipPathEl.setAttribute('d', initialFrame.clipPathD);
    overlay.rimPathEl.setAttribute('d', initialFrame.rimPathD);

    listenersAttached = true;
    window.addEventListener('resize', handleAbortEvent, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let startTimestamp: number | null = null;

    const step = (now: number) => {
      if (disposed || !overlay || !activeDirection || !activeTargetTheme) return;
      if (startTimestamp === null) startTimestamp = now;

      const progress = Math.min(1, Math.max(0, (now - startTimestamp) / durationMs));
      const frame = computeLiquidFrame(originX, originY, width, height, progress);

      overlay.clipPathEl.setAttribute('d', frame.clipPathD);
      overlay.rimPathEl.setAttribute('d', frame.rimPathD);

      if (frame.stage !== lastStage) {
        lastStage = frame.stage;
        options.audio?.onStage(frame.stage, activeDirection, progress);
      }
      if (frame.stage === 'rise') {
        options.audio?.onProgress(progress, activeDirection);
      }

      if (progress < 1) {
        rafId = requestAnimationFrame(step);
        return;
      }

      rafId = null;
      const finishedTheme = activeTargetTheme;
      const finishedDirection = activeDirection;
      detachWindowListeners();
      options.audio?.onComplete(finishedDirection);
      options.onCommitTheme(finishedTheme);

      // Keep the covered overlay for 1 frame so React updates underneath with zero flicker.
      postCommitRafId = requestAnimationFrame(() => {
        postCommitRafId = null;
        overlay?.destroy();
        overlay = null;
        activeTargetTheme = null;
        activeDirection = null;
        lastStage = null;
      });
    };

    rafId = requestAnimationFrame(step);
  };

  return {
    trigger,
    interrupt,
    isAnimating: () => rafId !== null || postCommitRafId !== null || overlay !== null,
    dispose: () => {
      disposed = true;
      interrupt(false);
      options.audio?.dispose();
    },
  };
}
