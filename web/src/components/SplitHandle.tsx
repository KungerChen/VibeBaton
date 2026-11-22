import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { clampPaneWidth, KEYBOARD_STEP_PX } from './splitPane';

interface SplitHandleProps {
  ariaLabel: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  side: 'left' | 'right';
  onChange(next: number): void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

export function SplitHandle({
  ariaLabel,
  hint,
  value,
  min,
  max,
  defaultValue,
  side,
  onChange,
}: SplitHandleProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: value };
    setDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = event.clientX - active.startX;
    const next = active.startWidth + (side === 'right' ? -delta : delta);
    onChange(clampPaneWidth(next, min, max));
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const growDirection = side === 'left' ? 1 : -1;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = value - KEYBOARD_STEP_PX * growDirection;
        break;
      case 'ArrowRight':
        next = value + KEYBOARD_STEP_PX * growDirection;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(clampPaneWidth(next, min, max));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel}
      title={hint}
      tabIndex={0}
      className="split-handle"
      data-dragging={dragging}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => onChange(defaultValue)}
    />
  );
}
