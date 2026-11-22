import { describe, expect, test } from 'vitest';
import { computeLiquidFrame } from './liquidGeometry';
import type { LiquidStage } from './types';

describe('liquidGeometry', () => {
  test.each([
    { label: 'mobile 375x667', width: 375, height: 667, ox: 290, oy: 48 },
    { label: 'desktop 1440x900', width: 1440, height: 900, ox: 1200, oy: 48 },
  ])(
    'sweeps p=0..1 at 0.001 step with zero NaN, monotonic stages, clockwise arcs, and sub-millisecond frame time ($label)',
    ({ width, height, ox, oy }) => {
      const seenStages: LiquidStage[] = [];
      const startMs = performance.now();

      for (let step = 0; step <= 1000; step += 1) {
        const p = step / 1000;
        const frame = computeLiquidFrame(ox, oy, width, height, p);

        expect(Number.isFinite(frame.waveLevelY)).toBe(true);
        expect(frame.clipPathD.startsWith('M ')).toBe(true);
        expect(frame.clipPathD).not.toContain('NaN');
        expect(frame.clipPathD).not.toContain('Infinity');
        expect(frame.rimPathD).not.toContain('NaN');
        expect(frame.rimPathD).not.toContain('Infinity');

        // Any circular arc droplet must be strictly clockwise (sweep=1: 0 1 1) so nonzero fill never punches holes.
        if (frame.clipPathD.includes(' a ')) {
          expect(frame.clipPathD).not.toMatch(/a\s+[\d.]+\s+[\d.]+\s+0\s+1\s+0/);
        }

        if (seenStages.at(-1) !== frame.stage) {
          seenStages.push(frame.stage);
        }
      }

      const elapsedMs = performance.now() - startMs;
      const perFrameMs = elapsedMs / 1001;

      expect(seenStages).toEqual(['pour', 'splash', 'rise', 'complete']);
      expect(perFrameMs).toBeLessThan(1.5);

      const finalFrame = computeLiquidFrame(ox, oy, width, height, 1);
      expect(finalFrame.stage).toBe('complete');
      expect(finalFrame.clipPathD).toBe(`M 0 0 H ${width} V ${height} H 0 Z`);
      expect(finalFrame.rimPathD).toBe('');
    },
  );
});
