# Liquid Theme Reveal (`liquid-theme`)

Reusable, dependency-free SVG fluid theme reveal + Web Audio procedural sound engine for React / TypeScript / Vite apps.

## Architecture
- **`liquidGeometry.ts`**: Pure clockwise SVG compound path generator (`clip-rule="nonzero"`) driven solely by `(originX, originY, width, height, progress)`:
  1. `pour` (`0.00 -> 0.26`): tapering sine-swaying stream dropping under gravity from the toggle button with 3 detached falling droplets.
  2. `splash` (`0.26 -> 0.56`): bottom impact crown, 6 parabolic splash droplets, and radially damped ripples.
  3. `rise` (`0.30 -> 0.96`): multi-harmonic wave surface smoothly sampled across 25 points (`Q` curves) rising to flood the viewport while the upper column pinches off.
  4. `complete` (`>= 0.96`): full-viewport settle rectangle.
- **`liquidAudio.ts`**: Pure Web Audio API synthesizer (`LiquidWebAudioEngine`) with reusable 2s white-noise buffer, pitch scaling (`to-dark: 0.75x`, `to-light: 1.3x`), default-off persistence, stage-driven triggers, click-free `30ms` ramp-down on interrupt/mute/dispose, and automatic `prefers-reduced-motion` short cue fallback.
- **`domSnapshot.ts` & `LiquidThemeEngine.ts`**: Single `requestAnimationFrame` loop updating only SVG `<path d>` attributes on the reveal overlay (`inert`, `aria-hidden="true"`, deduplicated DOM IDs & remapped intra-clone `url(#...)`/`for`/`aria-*`, preserved scroll & live input values).

## Quick Integration

```tsx
import {
  createLiquidThemeController,
  LiquidWebAudioEngine,
} from './liquid-theme';

const audio = new LiquidWebAudioEngine();
const controller = createLiquidThemeController({
  durationMs: 1150,
  respectReducedMotion: true, // Default true; pass false or open `?motion=full` to preview full fluid motion on OSes with reduced-motion enabled.
  audio,
  getSourceRoot: () => document.getElementById('root'),
  prepareClone: (cloneRoot, targetTheme) => {
    cloneRoot.querySelectorAll('.react-flow').forEach((el) => {
      el.classList.remove('dark', 'light');
      el.classList.add(targetTheme);
    });
  },
  onCommitTheme: (nextTheme) => {
    document.documentElement.dataset.theme = nextTheme;
  },
});

// Inside button click handler:
controller.trigger(currentTheme, nextTheme, event.currentTarget);
```

## Snapshot Scope & Limitations
Because the reveal overlay clones the current DOM subtree at trigger time (`cloneNode(true)` with CSS variable theme override):
- **Fully supported (re-styled live inside the reveal layer)**: All standard HTML elements, SVG markup (`@xyflow/react` nodes/edges/minimap), CSS custom property themes, sticky/fixed positioning, form values, and container scroll offsets.
- **Static pixel / limitation scope**: Bitmap `<canvas>`, WebGL contexts, playing `<video>` frames, and closed Shadow DOM trees are **not** automatically redrawn into the alternate theme inside the temporary `cloneNode(true)` snapshot; open native top-layer `<dialog.showModal()>` dialogs render above normal DOM stacking contexts.

## Default Standalone Palette Reference
For standalone apps without an existing CSS palette:
`#F1F0ED`, `#141319`, `#060609`, `#F4F2F8`, `#E07A2E`, `#2F6BFF`, `#14A3A8`.
