import type { LiquidFrame, LiquidStage } from './types';

function clamp(value: number, min: number, max: number): number {
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

function unitStep(a: number, b: number, p: number): number {
  if (b <= a) return p >= b ? 1 : 0;
  return clamp((p - a) / (b - a), 0, 1);
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function r1(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Emits a strictly clockwise circular subpath in screen coordinates (sweep=1)
 * so clip-rule="nonzero" never creates holes when overlapping another region.
 */
function cwCircle(cx: number, cy: number, radius: number): string {
  const rr = r1(radius);
  if (rr <= 0) return '';
  return `M ${r1(cx)} ${r1(cy)} m ${-rr} 0 a ${rr} ${rr} 0 1 1 ${r1(2 * rr)} 0 a ${rr} ${rr} 0 1 1 ${r1(-2 * rr)} 0 Z`;
}

function stageForProgress(p: number): LiquidStage {
  if (p < 0.26) return 'pour';
  if (p < 0.56) return 'splash';
  if (p < 0.96) return 'rise';
  return 'complete';
}

export function computeLiquidFrame(
  rawOriginX: number,
  rawOriginY: number,
  rawWidth: number,
  rawHeight: number,
  rawProgress: number,
): LiquidFrame {
  const W = Math.max(1, Number.isFinite(rawWidth) ? rawWidth : 1);
  const H = Math.max(1, Number.isFinite(rawHeight) ? rawHeight : 1);
  const ox = clamp(Number.isFinite(rawOriginX) ? rawOriginX : W * 0.5, 0, W);
  const oy = clamp(Number.isFinite(rawOriginY) ? rawOriginY : 0, -H, H - 1);
  const p = clamp(Number.isFinite(rawProgress) ? rawProgress : 0, 0, 1);
  const M = Math.min(W, H);
  const stage = stageForProgress(p);

  if (p >= 0.96) {
    return {
      stage: 'complete',
      progress: p,
      waveLevelY: -32,
      clipPathD: `M 0 0 H ${r1(W)} V ${r1(H)} H 0 Z`,
      rimPathD: '',
    };
  }

  const w0 = clamp(0.018 * M, 6, 18);
  const q = unitStep(0.26, 0.56, p);
  const R = 0.1 * M;
  const riseRatio = unitStep(0.3, 0.96, p);
  const easedRise = smoothstep(riseRatio);
  const waveLevelY = H + (-32 - H) * easedRise;
  const waveAmp = clamp(0.035 * M, 8, 28) * (0.35 + 0.65 * Math.sin(Math.PI * easedRise));
  const twoPi = Math.PI * 2;

  const evalRipple = (x: number): number => {
    if (q <= 0 || q >= 1) return 0;
    const dx = Math.abs(x - ox);
    return 0.25 * w0 * Math.exp(-3 * q) * Math.exp(-dx / (0.25 * W)) * Math.cos(0.08 * dx - 12 * q);
  };

  const evalWaveY = (x: number): number => {
    const u = x / W;
    const harmonic =
      0.55 * Math.sin(twoPi * u + 6 * p) +
      0.3 * Math.sin(4.6 * Math.PI * u - 9.1 * p + 1.3) +
      0.15 * Math.sin(9.4 * Math.PI * u + 13.7 * p + 2.1);
    return clamp(waveLevelY + waveAmp * harmonic + evalRipple(x), -64, H);
  };

  const subpaths: string[] = [];
  let rimPathD = '';

  // 1. Pouring column from below the toggle button down to the impact/wave level.
  const tHead = unitStep(0, 0.26, p);
  const pinch = unitStep(0.55, 0.65, p);
  const dropHeight = Math.max(1, H - oy);

  const swayCenterX = (y: number): number => {
    const u = clamp((y - oy) / dropHeight, 0, 1);
    return ox + 0.006 * M * u * Math.sin(0.045 * y + 14 * p);
  };

  if (tHead >= 0.02 && pinch < 1) {
    const waveYAtOrigin = evalWaveY(ox);
    const yEnd = p < 0.3 ? oy + dropHeight * tHead * tHead : Math.min(H, waveYAtOrigin + 10);
    const yTop = oy + (yEnd - oy) * pinch * pinch;
    const span = yEnd - yTop;

    if (span >= 2) {
      const steps = 5;
      const rightPts: [number, number][] = [];
      const leftPts: [number, number][] = [];
      let headRadius = w0 * 0.55;

      for (let i = 0; i <= steps; i += 1) {
        const frac = i / steps;
        const y = yTop + span * frac;
        const u = clamp((y - oy) / dropHeight, 0, 1);
        const halfW = Math.max(1.2, w0 * (1 - 0.45 * u) * (1 - 0.6 * pinch));
        const cx = swayCenterX(y);
        rightPts.push([cx + halfW, y]);
        leftPts.push([cx - halfW, y]);
        if (i === steps) headRadius = halfW;
      }

      const streamSegments: string[] = [`M ${r1(leftPts[0][0])} ${r1(leftPts[0][1])}`];
      streamSegments.push(`L ${r1(rightPts[0][0])} ${r1(rightPts[0][1])}`);
      for (let i = 1; i < rightPts.length; i += 1) {
        streamSegments.push(`L ${r1(rightPts[i][0])} ${r1(rightPts[i][1])}`);
      }
      const headR = r1(headRadius);
      streamSegments.push(
        `A ${headR} ${headR} 0 0 1 ${r1(leftPts[leftPts.length - 1][0])} ${r1(leftPts[leftPts.length - 1][1])}`,
      );
      for (let i = leftPts.length - 2; i >= 0; i -= 1) {
        streamSegments.push(`L ${r1(leftPts[i][0])} ${r1(leftPts[i][1])}`);
      }
      streamSegments.push('Z');
      subpaths.push(streamSegments.join(' '));
    }

    // Trailing stream droplets during fall & early impact.
    if (p < 0.38) {
      for (let i = 1; i <= 3; i += 1) {
        const dt = clamp(tHead * (1 + 0.08 * i), 0, 1);
        const yi = oy + dropHeight * dt * dt;
        const ri = w0 * (0.35 - 0.07 * i);
        const xi = swayCenterX(yi) + (i - 2) * 0.3 * w0;
        if (yi <= H - ri && ri >= 0.6) {
          subpaths.push(cwCircle(xi, yi, ri));
        }
      }
    }
  }

  // 2. Bottom impact splash crown and 6 parabolic droplets.
  if (q > 0 && q < 1) {
    const crownH = 1.2 * R * 4 * q * (1 - q);
    const crownW = w0 * (2 + 6 * q);
    if (crownH >= 1) {
      const baseBottom = H + 2;
      const crownPath = [
        `M ${r1(ox - crownW)} ${r1(baseBottom)}`,
        `Q ${r1(ox - 0.6 * crownW)} ${r1(H - crownH)} ${r1(ox - 0.3 * crownW)} ${r1(H - 0.6 * crownH)}`,
        `Q ${r1(ox)} ${r1(H - 0.25 * crownH)} ${r1(ox + 0.3 * crownW)} ${r1(H - 0.6 * crownH)}`,
        `Q ${r1(ox + 0.6 * crownW)} ${r1(H - crownH)} ${r1(ox + crownW)} ${r1(baseBottom)}`,
        'Z',
      ].join(' ');
      subpaths.push(crownPath);
    }

    const qPrime = q / 0.9;
    if (qPrime < 1) {
      for (let k = 0; k < 6; k += 1) {
        const theta = Math.PI / 2 + (k - 2.5) * 0.28;
        const dx = 1.6 * R * Math.cos(theta) * q;
        const x = ox + dx;
        const y = H - R * (0.8 + 0.4 * Math.sin(theta)) * 4 * qPrime * (1 - qPrime);
        const r = 0.3 * w0 * (1 - q);
        if (r >= 0.5 && x >= -r && x <= W + r) {
          subpaths.push(cwCircle(x, y, r));
        }
      }
    }
  }

  // 3. Rising multi-harmonic liquid wave floor.
  if (p >= 0.26) {
    const sampleCount = 25;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const xi = -2 + ((W + 4) * i) / (sampleCount - 1);
      xs.push(xi);
      ys.push(evalWaveY(xi));
    }

    const crestParts: string[] = [`M ${r1(xs[0])} ${r1(ys[0])}`];
    for (let i = 1; i < sampleCount - 2; i += 1) {
      const midX = (xs[i] + xs[i + 1]) / 2;
      const midY = (ys[i] + ys[i + 1]) / 2;
      crestParts.push(`Q ${r1(xs[i])} ${r1(ys[i])} ${r1(midX)} ${r1(midY)}`);
    }
    const lastIdx = sampleCount - 1;
    crestParts.push(
      `Q ${r1(xs[lastIdx - 1])} ${r1(ys[lastIdx - 1])} ${r1(xs[lastIdx])} ${r1(ys[lastIdx])}`,
    );

    const crest = crestParts.join(' ');
    rimPathD = crest;
    subpaths.push(`${crest} L ${r1(W + 2)} ${r1(H + 2)} L -2 ${r1(H + 2)} Z`);
  }

  const joinedPath = subpaths.filter(Boolean).join(' ');
  return {
    stage,
    progress: p,
    waveLevelY: r1(waveLevelY),
    clipPathD: joinedPath || `M ${r1(ox)} ${r1(oy)} Z`,
    rimPathD,
  };
}
