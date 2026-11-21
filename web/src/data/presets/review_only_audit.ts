import type { WorkflowGraph } from '../../types/graph';

export const review_only_audit: WorkflowGraph = {
  schema_version: '1.0',
  id: 'review_only_audit',
  name: '只读审计流水线 (Review-Only Audit)',
  difficulty: 'beginner',
  description: '只读审计流水线：自动运行测试与静态检查，由 Codex 做安全微审、Claude Opus 做架构评审。全程只读、不写代码、不产生修复循环，审校结论交由用户最终确认，适合审计现有代码库。',
  recommended_for: ['代码审计 (Code audit)', '安全审查 (Security review)', 'PR 验证 (PR verification)'],
  nodes: [
    {
      id: 'audit_gate',
      type: 'gate_node',
      label: '审计门禁 (Tests / Lint)',
      position: { x: 80, y: 160 },
      config: {
        commands: ['python -m unittest discover -s tests', 'python -m ruff check .'],
      },
    },
    {
      id: 'micro_security_review',
      type: 'reviewer_node',
      label: '安全微审 (Codex Astra)',
      role: 'micro_orchestrator',
      position: { x: 380, y: 160 },
      config: { provider: 'codex_sub', model: 'gpt-6.2-astra@xhigh' },
    },
    {
      id: 'architecture_review',
      type: 'reviewer_node',
      label: '架构评审 (Claude Opus)',
      role: 'milestone_reviewer',
      position: { x: 680, y: 160 },
      config: { provider: 'claude_sub', model: 'opus@high' },
    },
    {
      id: 'human_final',
      type: 'human_gate_node',
      label: '人工审计确认',
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
