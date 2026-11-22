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
import { formatProviderDisplay, translateHandle, translatePresetText, translateRole } from '../../i18n/presets';
import { cn } from '../../lib/utils';
import {
  tierForNodeType,
  type ExecutionState,
  type NodeType,
  type TierKey,
} from '../../types/graph';
import {
  BaseNode,
  BaseNodeContent,
  BaseNodeFooter,
  BaseNodeHeader,
  BaseNodeHeaderTitle,
  NodeStatusBadge,
} from '../ui/base-node';

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
  L1: '#7c3aed',
  L2: '#0ea5e9',
  L3: '#10b981',
  GATE: '#6366f1',
  MERGE: '#64748b',
  ROUTER: '#14b8a6',
  HUMAN: '#f43f5e',
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

const STATE_BADGE_VARIANT: Record<
  Exclude<ExecutionState, 'idle'>,
  'info' | 'warning' | 'destructive' | 'success'
> = {
  active: 'info',
  retrying: 'warning',
  escalated: 'destructive',
  passed: 'success',
  failed: 'destructive',
};

function portToneClass(portId: string): string {
  if (portId === 'pass' || portId === 'approve') return 'baton-node__port-tag--ok';
  if (portId === 'fail' || portId === 'minor_fix' || portId === 'reject') return 'baton-node__port-tag--warn';
  if (portId === 'escalate') return 'baton-node__port-tag--err';
  return '';
}

export const BatonNode = memo(function BatonNode({ data, isConnectable, selected }: NodeProps<BatonFlowNode>) {
  const { locale, messages } = useI18n();
  const { label, nodeType, role, provider, model, max_loops: maxLoops, concurrency, state = 'idle' } = data;
  const tier = tierForNodeType(nodeType, role);
  const tierColor = TIER_COLORS[tier];
  const Icon = NODE_ICONS[nodeType];
  const { targets, sources } = NODE_HANDLES[nodeType];
  const modelLabel = model && (provider ? `${formatProviderDisplay(provider)} / ${model}` : model);
  const parallelCount = concurrency !== undefined && concurrency > 1 ? concurrency : undefined;
  const stateText = state !== 'idle' ? messages.nodeStates[state] : undefined;
  const localizedLabel = translatePresetText(label, locale);
  const localizedRole = role ? translateRole(role, locale) : undefined;
  const nodeTypeLabel = messages.nodeTypes[nodeType];

  const style = {
    '--tier-color': tierColor,
  } as CSSProperties;

  return (
    <BaseNode
      style={style}
      className={cn(
        'baton-node w-[272px]',
        `baton-node--${state}`,
        selected && 'baton-node--selected',
      )}
    >
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

      <BaseNodeHeader>
        <div
          className="baton-node__squircle flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
          aria-hidden="true"
        >
          <Icon size={16} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
            <span className="baton-node__tier">
              {tier} · {nodeTypeLabel}
            </span>
            {stateText && state !== 'idle' && (
              <NodeStatusBadge
                variant={STATE_BADGE_VARIANT[state]}
                className={state === 'active' ? 'baton-node__badge--active' : undefined}
              >
                {stateText}
              </NodeStatusBadge>
            )}
          </div>
          <BaseNodeHeaderTitle title={localizedLabel}>
            {localizedLabel}
          </BaseNodeHeaderTitle>
        </div>
      </BaseNodeHeader>

      {(localizedRole || modelLabel || maxLoops !== undefined || parallelCount !== undefined) && (
        <BaseNodeContent>
          {localizedRole && (
            <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">
              {localizedRole}
            </p>
          )}
          {(modelLabel || maxLoops !== undefined || parallelCount !== undefined) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {modelLabel && (
                <span
                  className="max-w-full truncate rounded-md border border-border bg-muted/75 px-2 py-0.5 font-mono text-[10px] text-foreground"
                  title={modelLabel}
                >
                  {modelLabel}
                </span>
              )}
              {parallelCount !== undefined && (
                <NodeStatusBadge variant="success" title={messages.nodeCard.parallelWorkersTitle}>
                  ⚡ ×{parallelCount}
                </NodeStatusBadge>
              )}
              {maxLoops !== undefined && (
                <NodeStatusBadge variant="warning">
                  ↻ ×{maxLoops}
                </NodeStatusBadge>
              )}
            </div>
          )}
        </BaseNodeContent>
      )}

      {sources.length > 0 && (
        <BaseNodeFooter className="px-0 py-1.5">
          {sources.map((id) => (
            <div
              key={id}
              className="relative flex items-center justify-end px-3.5 py-0.5"
            >
              <span className={cn('baton-node__port-tag', portToneClass(id))}>
                {translateHandle(id, locale)}
              </span>
              <Handle
                className="baton-node__handle"
                type="source"
                position={Position.Right}
                id={id}
                isConnectable={isConnectable}
              />
            </div>
          ))}
        </BaseNodeFooter>
      )}
    </BaseNode>
  );
});
