import './BatonEdge.css';
import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

export type EdgeSemanticTone = 'normal' | 'retry' | 'escalate';

export const EDGE_TONE_COLORS: Record<
  EdgeSemanticTone,
  { active: string; traversed: string; labelBg: string }
> = {
  normal: { active: '#22d3ee', traversed: '#34d399', labelBg: 'rgba(52, 211, 153, 0.16)' },
  retry: { active: '#f59e0b', traversed: '#d97706', labelBg: 'rgba(245, 158, 11, 0.16)' },
  escalate: { active: '#ec4899', traversed: '#db2777', labelBg: 'rgba(236, 72, 153, 0.18)' },
};

export function edgeSemanticTone(sourceHandle?: string | null): EdgeSemanticTone {
  if (sourceHandle === 'escalate') return 'escalate';
  if (sourceHandle === 'fail' || sourceHandle === 'minor_fix' || sourceHandle === 'reject') {
    return 'retry';
  }
  return 'normal';
}

export const BatonEdge = memo(function BatonEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  label,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const edgeData = (data ?? {}) as {
    active?: boolean;
    traversed?: boolean;
    semanticTone?: EdgeSemanticTone;
  };
  const active = Boolean(edgeData.active);
  const traversed = Boolean(edgeData.traversed);
  const tone = edgeData.semanticTone ?? edgeSemanticTone(sourceHandleId);
  const palette = EDGE_TONE_COLORS[tone];
  const stroke = active ? palette.active : traversed ? palette.traversed : 'var(--slate)';
  const strokeWidth = active ? 3 : traversed ? 2 : 1.25;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke,
          strokeWidth,
          filter: active ? `drop-shadow(0 0 6px ${palette.active})` : undefined,
        }}
      />
      {active && (
        <g className="baton-edge__particles" aria-hidden="true">
          <circle r={7.5} fill={palette.active} opacity={0.28}>
            <animateMotion dur="0.85s" repeatCount="indefinite" path={edgePath} />
          </circle>
          <circle r={4} fill={palette.active} opacity={0.98}>
            <animateMotion dur="0.85s" repeatCount="indefinite" path={edgePath} />
          </circle>
        </g>
      )}
      {Boolean(label) && (
        <EdgeLabelRenderer>
          <div
            className={`baton-edge__label baton-edge__label--${tone}${
              active ? ' baton-edge__label--active' : ''
            }${selected ? ' baton-edge__label--selected' : ''} nopan`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: active || traversed ? palette.labelBg : undefined,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
