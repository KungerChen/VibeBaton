import type { WorkflowGraph } from '../../types/graph';

export const review_only_audit: WorkflowGraph = {
  schema_version: '1.0',
  id: 'review_only_audit',
  name: 'Review-Only Audit',
  difficulty: 'beginner',
  description: 'Read-only audit pipeline: runs automated tests and lint checks, followed by Codex security micro-review and Claude Opus architecture review. Never modifies code; hands findings to a human for final sign-off.',
  recommended_for: ['Code audit', 'Security review', 'PR verification'],
  category: 'audit',
  required_providers: ['codex_sub', 'claude_sub'],
  cost_tier: 'medium',
  inspired_by: 'VibeBaton mechanical gate principle',
  nodes: [
    {
      id: 'audit_gate',
      type: 'gate_node',
      label: 'Audit Gate (Tests / Lint)',
      position: { x: 80, y: 160 },
      config: {
        commands: ['python -m unittest discover -s tests', 'python -m ruff check .'],
      },
    },
    {
      id: 'micro_security_review',
      type: 'reviewer_node',
      label: 'Security Micro-Review (Codex Astra)',
      role: 'micro_orchestrator',
      position: { x: 380, y: 160 },
      config: { provider: 'codex_sub', model: 'gpt-6.2-astra@xhigh' },
    },
    {
      id: 'architecture_review',
      type: 'reviewer_node',
      label: 'Architecture Review (Claude Opus)',
      role: 'milestone_reviewer',
      position: { x: 680, y: 160 },
      config: { provider: 'claude_sub', model: 'opus@high' },
    },
    {
      id: 'human_final',
      type: 'human_gate_node',
      label: 'Human Audit Sign-Off',
      position: { x: 980, y: 160 },
      config: {},
    },
  ],
  edges: [
    { id: 'e1', source: 'audit_gate', sourceHandle: 'pass', target: 'micro_security_review', targetHandle: 'in' },
    { id: 'e2', source: 'micro_security_review', sourceHandle: 'pass', target: 'architecture_review', targetHandle: 'in' },
    { id: 'e3', source: 'architecture_review', sourceHandle: 'pass', target: 'human_final', targetHandle: 'in' },
  ],
};
