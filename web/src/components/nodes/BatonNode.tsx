import './BatonNode.css';
import { memo, type CSSProperties } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Compass,
  Eye,
  GitFork,
  Hammer,
  Merge,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { translateHandle, translatePresetText, translateRole } from '../../i18n/presets';
import {
  tierForNodeType,
  type ExecutionState,
  type NodeType,
  type TierKey,
} from '../../types/graph';

export type BatonNodeData = {
  label: string;
  nodeType: NodeType;
  role?: string;
  provider?: string;
  model?: string;
  max_loops?: number;
  concurrency?: number;
  state: ExecutionState;
};

export type BatonFlowNode = Node<BatonNodeData, 'baton'>;

export const TIER_COLORS: Record<TierKey, string> = {
  L0: '#f59e0b',
  L1: '#8b5cf6',
  L2: '#38bdf8',
  L3: '#34d399',
  GATE: '#818cf8',
  MERGE: '#64748b',
  ROUTER: '#2dd4bf',
  HUMAN: '#fb7185',
};

export const NODE_ICONS: Record<NodeType, LucideIcon> = {
  planner_node: Compass,
  router_node: GitFork,
  worker_node: Hammer,
  gate_node: ShieldCheck,
  reviewer_node: Eye,
  merge_node: Merge,
  human_gate_node: UserCheck,
};

// The presets also connect to planner rfc/out and reviewer pass/minor_fix.
export const NODE_HANDLES: Record<NodeType, { targets: string[]; sources: string[] }> = {
  planner_node: { targets: ['in'], sources: ['dag', 'critical', 'routine', 'rfc', 'out'] },
  router_node: { targets: ['in'], sources: ['critical', 'routine', 'out'] },
  worker_node: { targets: ['in', 'fix'], sources: ['out'] },
  gate_node: { targets: ['in'], sources: ['pass', 'fail', 'escalate'] },
  reviewer_node: { targets: ['in'], sources: ['approve', 'reject', 'escalate', 'pass', 'minor_fix'] },
  merge_node: { targets: ['in'], sources: ['out'] },
  human_gate_node: { targets: ['in'], sources: ['approve', 'reject'] },
};

export const BatonNode = memo(function BatonNode({ data, isConnectable, selected }: NodeProps<BatonFlowNode>) {
  const { locale, messages } = useI18n();
  const { label, nodeType, role, provider, model, max_loops: maxLoops, concurrency, state = 'idle' } = data;
  const tier = tierForNodeType(nodeType, role);
  const tierColor = TIER_COLORS[tier];
  const Icon = NODE_ICONS[nodeType];
  const { targets, sources } = NODE_HANDLES[nodeType];
  const modelLabel = model && (provider ? `${provider} / ${model}` : model);
  const parallelCount = concurrency !== undefined && concurrency > 1 ? concurrency : undefined;
  const stateText = state !== 'idle' ? messages.nodeStates[state] : undefined;
  const stateBadge = stateText ? { text: stateText, className: `baton-node__badge--${state}` } : undefined;
  const localizedLabel = translatePresetText(label, locale);
  const localizedRole = role ? translateRole(role, locale) : undefined;
  const nodeTypeLabel = messages.nodeTypes[nodeType];

  const style = {
    '--tier-color': tierColor,
    '--tier-border': `${tierColor}99`,
    '--tier-glow': `${tierColor}55`,
    '--tier-glow-soft': `${tierColor}22`,
  } as CSSProperties;

  const className = `baton-node baton-node--${state}${selected ? ' baton-node--selected' : ''}`;

  return (
    <div className={className} style={style}>
      {targets.map((id, index) => (
        <Handle
          key={id}
          className="baton-node__handle"
          type="target"
          position={Position.Left}
          id={id}
          isConnectable={isConnectable}
          style={{ top: `${(100 * (index + 1)) / (targets.length + 1)}%` }}
        />
      ))}

      <div className="baton-node__content">
        <div className="baton-node__header">
          <Icon className="baton-node__icon" size={14} aria-hidden="true" />
          <span className="baton-node__tier">
            {tier} · {nodeTypeLabel}
          </span>
          <span className="baton-node__label" title={localizedLabel}>
            {localizedLabel}
          </span>
        </div>

        {localizedRole && <div className="baton-node__role">{localizedRole}</div>}

        {(modelLabel || maxLoops !== undefined || parallelCount !== undefined || stateBadge) && (
          <div className="baton-node__meta">
            {modelLabel && (
              <span className="baton-node__model" title={modelLabel}>
                {modelLabel}
              </span>
            )}
            {parallelCount !== undefined && (
              <span className="baton-node__concurrency" title={messages.nodeCard.parallelWorkersTitle}>
                ⚡ ×{parallelCount}
              </span>
            )}
            {maxLoops !== undefined && <span className="baton-node__loops">↻ ×{maxLoops}</span>}
            {stateBadge && (
              <span className={`baton-node__badge ${stateBadge.className}`}>
                {stateBadge.text}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="baton-node__sources">
        {sources.map((id) => (
          <div key={id} className="baton-node__source">
            {translateHandle(id, locale)}
            <Handle
              className="baton-node__handle"
              type="source"
              position={Position.Right}
              id={id}
              isConnectable={isConnectable}
            />
          </div>
        ))}
      </div>
    </div>
  );
});
