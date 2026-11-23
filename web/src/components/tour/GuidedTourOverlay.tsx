import './GuidedTourOverlay.css';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { tourSelector, type GuidedTourOverlayProps, type TourStep } from './tourSteps';

const SPOTLIGHT_PADDING = 8;
const SPOTLIGHT_RADIUS = 12;
const POPOVER_GAP = 12;
const VIEWPORT_MARGIN = 12;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

type Placement = 'below' | 'above' | 'left' | 'right' | 'center';

interface PopoverPosition {
  top: number;
  left: number;
  placement: Placement;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readViewportSize(): Size {
  return {
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  };
}

function measureTarget(id: TourStep['id']): Box | null {
  const target = document.querySelector(tourSelector(id));
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function getSpotlight(target: Box | null, viewport: Size): Box | null {
  if (!target) return null;
  const left = clamp(target.left - SPOTLIGHT_PADDING, 0, viewport.width);
  const top = clamp(target.top - SPOTLIGHT_PADDING, 0, viewport.height);
  const right = clamp(target.left + target.width + SPOTLIGHT_PADDING, 0, viewport.width);
  const bottom = clamp(target.top + target.height + SPOTLIGHT_PADDING, 0, viewport.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function getPopoverPosition(spotlight: Box | null, popover: Size, viewport: Size): PopoverPosition {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - popover.width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - popover.height - VIEWPORT_MARGIN);
  const clampLeft = (value: number) => clamp(value, VIEWPORT_MARGIN, maxLeft);
  const clampTop = (value: number) => clamp(value, VIEWPORT_MARGIN, maxTop);

  if (!spotlight) {
    return {
      top: clampTop((viewport.height - popover.height) / 2),
      left: clampLeft((viewport.width - popover.width) / 2),
      placement: 'center',
    };
  }

  const centeredLeft = spotlight.left + spotlight.width / 2 - popover.width / 2;
  const centeredTop = spotlight.top + spotlight.height / 2 - popover.height / 2;
  const below = spotlight.top + spotlight.height + POPOVER_GAP;
  const above = spotlight.top - POPOVER_GAP - popover.height;
  const toLeft = spotlight.left - POPOVER_GAP - popover.width;
  const toRight = spotlight.left + spotlight.width + POPOVER_GAP;

  if (below + popover.height <= viewport.height - VIEWPORT_MARGIN) {
    return { top: below, left: clampLeft(centeredLeft), placement: 'below' };
  }
  if (above >= VIEWPORT_MARGIN) {
    return { top: above, left: clampLeft(centeredLeft), placement: 'above' };
  }
  if (toLeft >= VIEWPORT_MARGIN) {
    return { top: clampTop(centeredTop), left: toLeft, placement: 'left' };
  }
  if (toRight + popover.width <= viewport.width - VIEWPORT_MARGIN) {
    return { top: clampTop(centeredTop), left: toRight, placement: 'right' };
  }

  const candidates: readonly [Placement, number][] = [
    ['below', viewport.height - VIEWPORT_MARGIN - below - popover.height],
    ['above', above - VIEWPORT_MARGIN],
    ['left', toLeft - VIEWPORT_MARGIN],
    ['right', viewport.width - VIEWPORT_MARGIN - toRight - popover.width],
  ];
  let placement: Placement = 'below';
  let room = Number.NEGATIVE_INFINITY;
  for (const [candidate, candidateRoom] of candidates) {
    if (candidateRoom > room) {
      placement = candidate;
      room = candidateRoom;
    }
  }

  if (placement === 'above') return { top: clampTop(above), left: clampLeft(centeredLeft), placement };
  if (placement === 'left') return { top: clampTop(centeredTop), left: clampLeft(toLeft), placement };
  if (placement === 'right') return { top: clampTop(centeredTop), left: clampLeft(toRight), placement };
  return { top: clampTop(below), left: clampLeft(centeredLeft), placement };
}

export function GuidedTourOverlay({
  steps,
  stepIndex,
  onStepChange,
  onClose,
  onRequirePane,
}: GuidedTourOverlayProps) {
  const { messages } = useI18n();
  const step = steps[stepIndex];
  const total = steps.length;
  const stepId = step?.id;
  const requiredPane = step?.requiredPane;
  const requiredInspectorTab = step?.requiredInspectorTab;

  const [target, setTarget] = useState<Box | null>(null);
  const [viewport, setViewport] = useState<Size>(readViewportSize);
  const [popoverSize, setPopoverSize] = useState<Size>({ width: 0, height: 0 });
  const popoverRef = useRef<HTMLElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const onRequirePaneRef = useRef(onRequirePane);
  onRequirePaneRef.current = onRequirePane;

  const baseId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const titleId = `guided-tour-title-${baseId}`;
  const maskId = `guided-tour-mask-${baseId}`;

  useLayoutEffect(() => {
    if (!stepId) {
      setTarget(null);
      return;
    }

    let frame = 0;
    let observedTarget: Element | null = null;
    let resizeObserver: ResizeObserver | null = null;

    if (requiredPane || requiredInspectorTab) {
      onRequirePaneRef.current?.(requiredPane ?? null, requiredInspectorTab ?? null);
    }

    const measure = () => {
      const nextViewport = readViewportSize();
      setViewport((previous) => (
        previous.width === nextViewport.width && previous.height === nextViewport.height
          ? previous
          : nextViewport
      ));

      const nextTarget = measureTarget(stepId);
      setTarget((previous) => {
        if (!nextTarget) return previous === null ? previous : null;
        if (
          previous
          && previous.top === nextTarget.top
          && previous.left === nextTarget.left
          && previous.width === nextTarget.width
          && previous.height === nextTarget.height
        ) {
          return previous;
        }
        return nextTarget;
      });
    };

    const observeCurrentTarget = () => {
      if (!resizeObserver) return;
      const node = document.querySelector(tourSelector(stepId));
      if (node === observedTarget) return;
      resizeObserver.disconnect();
      observedTarget = node;
      if (node) resizeObserver.observe(node);
    };

    const remeasure = () => {
      observeCurrentTarget();
      measure();
    };

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(remeasure);
    }

    remeasure();

    if ((requiredPane || requiredInspectorTab) && typeof requestAnimationFrame === 'function') {
      // Measure again after pane selection has made the target visible.
      frame = requestAnimationFrame(() => {
        document.querySelector(tourSelector(stepId))?.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: 'instant',
        });
        remeasure();
      });
    }

    window.addEventListener('resize', remeasure);
    document.addEventListener('scroll', remeasure, true);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', remeasure);
      document.removeEventListener('scroll', remeasure, true);
    };
  }, [requiredInspectorTab, requiredPane, stepId]);

  useLayoutEffect(() => {
    if (!stepId) return;
    const node = popoverRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPopoverSize((previous) => (
      previous.width === rect.width && previous.height === rect.height
        ? previous
        : { width: rect.width, height: rect.height }
    ));
  }, [messages, stepId, stepIndex, total, viewport.height, viewport.width]);

  useEffect(() => {
    if (!stepId) return;
    nextButtonRef.current?.focus({ preventScroll: true });
  }, [stepId, stepIndex]);

  useEffect(() => {
    if (!stepId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, stepId]);

  if (!step || typeof document === 'undefined') return null;

  const copy = messages.tour.steps[step.id];
  const isLast = stepIndex >= total - 1;
  const spotlight = getSpotlight(target, viewport);
  const position = getPopoverPosition(spotlight, popoverSize, viewport);

  const advance = () => {
    if (stepIndex < total - 1) {
      onStepChange(stepIndex + 1);
      return;
    }
    onClose();
  };

  const goBack = () => {
    if (stepIndex > 0) onStepChange(stepIndex - 1);
  };

  return createPortal(
    <>
      <svg
        className="guided-tour__overlay"
        width="100%"
        height="100%"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <mask
            id={maskId}
            maskUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={viewport.width}
            height={viewport.height}
          >
            <rect x={0} y={0} width={viewport.width} height={viewport.height} fill="white" />
            {spotlight && (
              <rect
                x={spotlight.left}
                y={spotlight.top}
                width={spotlight.width}
                height={spotlight.height}
                rx={SPOTLIGHT_RADIUS}
                fill="black"
              />
            )}
          </mask>
        </defs>

        <rect
          className="guided-tour__backdrop"
          x={0}
          y={0}
          width={viewport.width}
          height={viewport.height}
          mask={`url(#${maskId})`}
        />

        {spotlight && (
          <rect
            className="guided-tour__target"
            x={spotlight.left}
            y={spotlight.top}
            width={spotlight.width}
            height={spotlight.height}
            rx={SPOTLIGHT_RADIUS}
            fill="transparent"
            pointerEvents="all"
            onClick={advance}
          />
        )}
      </svg>

      <section
        ref={popoverRef}
        className="guided-tour__popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-placement={position.placement}
        style={{ top: `${position.top}px`, left: `${position.left}px` }}
      >
        <p className="guided-tour__progress">
          {messages.tour.stepProgress(stepIndex + 1, total)}
        </p>
        <h2 className="guided-tour__title" id={titleId}>{copy.title}</h2>
        <p className="guided-tour__description">{copy.description}</p>
        <p className="guided-tour__hint">{copy.hint}</p>
        <p className="guided-tour__click-hint">{messages.tour.clickHint}</p>

        <div className="guided-tour__actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            {messages.tour.skip}
          </Button>
          <div className="guided-tour__nav">
            <Button
              variant="secondary"
              size="sm"
              onClick={goBack}
              disabled={stepIndex <= 0}
            >
              {messages.tour.prev}
            </Button>
            <Button
              ref={nextButtonRef}
              variant="default"
              size="sm"
              onClick={advance}
            >
              {isLast ? messages.tour.finish : messages.tour.next}
            </Button>
          </div>
        </div>
      </section>
    </>,
    document.body,
  );
}
