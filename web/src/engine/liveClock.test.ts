import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ACTIVE_RUN_STATUSES,
  computeClockSkewSec,
  computeLiveSeconds,
  formatDurationSec,
  formatLiveDuration,
  isRunStatusActive,
  useLiveClock,
} from './liveClock';

describe('isRunStatusActive', () => {
  test('recognizes the five active run statuses', () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(['PLANNING', 'RUNNING', 'IN_PROGRESS', 'REVIEWING', 'GATE_CHECKING']);
    for (const status of ACTIVE_RUN_STATUSES) {
      expect(isRunStatusActive(status)).toBe(true);
    }
    for (const status of ['PAUSED', 'WAITING_HUMAN', 'READY_FOR_FINAL_GATE', 'COMPLETED', 'FAILED', null, undefined, 42]) {
      expect(isRunStatusActive(status)).toBe(false);
    }
  });
});

describe('computeLiveSeconds', () => {
  test.each([false, undefined])('preserves the base when activity is %s', (isActive) => {
    expect(computeLiveSeconds(12.5, 100, isActive, 120)).toBe(12.5);
  });

  test.each([null, undefined, NaN, Infinity])('preserves the base with start time %s', (startedAt) => {
    expect(computeLiveSeconds(12.5, startedAt, true, 120)).toBe(12.5);
  });

  test('adds elapsed time and accepts an epoch-zero start', () => {
    expect(computeLiveSeconds(12.5, 100, true, 120)).toBe(32.5);
    expect(computeLiveSeconds(0, 0, true, 10)).toBe(10);
  });

  test('clamps elapsed time to zero before the start', () => {
    expect(computeLiveSeconds(12.5, 120, true, 100)).toBe(12.5);
  });
});

describe('computeClockSkewSec', () => {
  test.each([null, undefined, NaN, Infinity])('returns zero for server time %s', (serverNow) => {
    expect(computeClockSkewSec(serverNow, 100)).toBe(0);
  });

  test('preserves the sign and precision of the server offset', () => {
    expect(computeClockSkewSec(110.25, 100)).toBe(10.25);
    expect(computeClockSkewSec(0, 100)).toBe(-100);
  });

  test('defaults the client sample to epoch seconds', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_250);
    try {
      expect(computeClockSkewSec(110)).toBe(9.75);
    } finally {
      now.mockRestore();
    }
  });
});

describe('formatLiveDuration', () => {
  test.each([
    [NaN, '0s', '0秒'],
    [-1, '0s', '0秒'],
    [42.9, '42s', '42秒'],
    [60, '1m 00s', '1分00秒'],
    [258, '4m 18s', '4分18秒'],
    [3725, '1h 02m 05s', '1小时02分05秒'],
  ] as const)('formats %s seconds in English and Chinese', (sec, en, zh) => {
    expect(formatLiveDuration(sec, 'en')).toBe(en);
    expect(formatLiveDuration(sec, 'zh')).toBe(zh);
  });
});

test('live durations keep displaying seconds during long runs', () => {
  expect(formatDurationSec(3600, 'en', true)).toBe('1h 00m 00s');
  expect(formatDurationSec(3601, 'en', true)).toBe('1h 00m 01s');
  expect(formatDurationSec(3601, 'zh', true)).toBe('1小时00分01秒');
  expect(formatDurationSec(3601, 'en')).toBe('1h 0m');
});

describe('useLiveClock', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { HTMLIFrameElement: class HTMLIFrameElement {} });
  });

  afterEach(() => {
    try {
      cleanup?.();
    } finally {
      cleanup = undefined;
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  function renderHook<Props, Value>(useHook: (props: Props) => Value, initialProps: NoInfer<Props>) {
    // The probe renders null, so React only needs a root container for event registration.
    const container = { nodeType: 1, tagName: 'DIV', ownerDocument: null, addEventListener() {} };
    const root = createRoot(container as unknown as HTMLElement);
    let value: Value;
    let renderCount = 0;

    function Probe({ hookProps }: { hookProps: Props }) {
      value = useHook(hookProps);
      renderCount += 1;
      return null;
    }

    function rerender(hookProps: Props) {
      act(() => root.render(createElement(StrictMode, null, createElement(Probe, { hookProps }))));
    }

    function unmount() {
      act(() => root.unmount());
    }

    cleanup = unmount;
    rerender(initialProps);
    return {
      get value() { return value; },
      get renderCount() { return renderCount; },
      rerender,
      unmount,
    };
  }

  function advanceTime(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  function useClock({ active, serverNow }: { active: boolean; serverNow?: number | null }) {
    return useLiveClock(active, serverNow);
  }

  test.each(['COMPLETED', 'READY_FOR_FINAL_GATE', 'FAILED', 'HALTED'])(
    'leaves a %s snapshot frozen without scheduling an interval',
    (status) => {
      const schedule = vi.spyOn(globalThis, 'setInterval');
      try {
        const hook = renderHook(useClock, { active: isRunStatusActive(status), serverNow: 150 });
        advanceTime(3000);
        expect(hook.value).toBe(150);
        expect(schedule).not.toHaveBeenCalled();
      } finally {
        schedule.mockRestore();
      }
    },
  );

  test('ticks every second while active and stays stable after deactivation', () => {
    const hook = renderHook(useClock, { active: false, serverNow: 150 });
    const initialRenders = hook.renderCount;
    expect(hook.value).toBe(150);
    expect(vi.getTimerCount()).toBe(0);
    advanceTime(3000);
    expect(hook.value).toBe(150);
    expect(hook.renderCount).toBe(initialRenders);

    hook.rerender({ active: true, serverNow: 150 });
    expect(hook.value).toBe(153);
    expect(vi.getTimerCount()).toBe(1);
    advanceTime(999);
    expect(hook.value).toBe(153);
    advanceTime(1);
    expect(hook.value).toBe(154);

    hook.rerender({ active: false, serverNow: 150 });
    const stoppedRenders = hook.renderCount;
    expect(vi.getTimerCount()).toBe(0);
    advanceTime(2000);
    expect(hook.value).toBe(154);
    expect(hook.renderCount).toBe(stoppedRenders);
    hook.rerender({ active: false, serverNow: 150 });
    expect(hook.value).toBe(154);

    hook.rerender({ active: false, serverNow: 155 });
    expect(hook.value).toBe(155);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('resynchronizes an active clock on server updates and clears the interval on unmount', () => {
    const hook = renderHook(useClock, { active: true, serverNow: 150 });
    expect(hook.value).toBe(150);
    expect(vi.getTimerCount()).toBe(1);

    advanceTime(500);
    hook.rerender({ active: true, serverNow: 200 });
    expect(hook.value).toBe(200);
    expect(vi.getTimerCount()).toBe(1);
    advanceTime(500);
    expect(hook.value).toBe(200.5);

    hook.rerender({ active: true, serverNow: null });
    expect(hook.value).toBe(101);
    advanceTime(1000);
    expect(hook.value).toBe(102);

    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
