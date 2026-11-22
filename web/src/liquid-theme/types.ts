export type LiquidTheme = 'dark' | 'light';

export type LiquidDirection = 'to-dark' | 'to-light';

export type LiquidStage = 'pour' | 'splash' | 'rise' | 'complete';

export type LiquidOrigin =
  | HTMLElement
  | { x: number; y: number }
  | (() => { x: number; y: number } | null)
  | null
  | undefined;

export interface LiquidFrame {
  stage: LiquidStage;
  progress: number;
  waveLevelY: number;
  clipPathD: string;
  rimPathD: string;
}

export interface LiquidAudioAdapter {
  unlock(): Promise<void> | void;
  onStage(stage: LiquidStage, direction: LiquidDirection, progress: number): void;
  onProgress(progress: number, direction: LiquidDirection): void;
  onComplete(direction: LiquidDirection): void;
  onInterrupt(): void;
  playReducedMotionCue(direction: LiquidDirection): void;
  setEnabled(enabled: boolean): void;
  setVolume(volume: number): void;
  dispose(): void;
}

export interface LiquidRevealOptions {
  /** Root container to snapshot into the reveal overlay (defaults to `#root` or `document.body`). */
  getSourceRoot?: () => HTMLElement | null;
  /** Host element to mount fixed reveal overlay inside (defaults to `document.body`). */
  getMountTarget?: () => HTMLElement | null;
  /** Transition duration in milliseconds (default `1150`). */
  durationMs?: number;
  /** Optional custom attribute/theme applicator inside the reveal overlay root. */
  prepareClone?: (cloneRoot: HTMLElement, targetTheme: LiquidTheme) => void;
  /** Commit the active theme cleanly once liquid covers the viewport. */
  onCommitTheme: (nextTheme: LiquidTheme) => void;
  /** Optional audio adapter driven directly by real animation stage & progress. */
  audio?: LiquidAudioAdapter | null;
}

export interface LiquidThemeController {
  trigger(currentTheme: LiquidTheme, nextTheme: LiquidTheme, origin?: LiquidOrigin): void;
  interrupt(commitTarget?: boolean): void;
  isAnimating(): boolean;
  dispose(): void;
}
