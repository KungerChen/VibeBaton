import type { Locale } from './messages';

export const EN_TO_ZH_PRESET_TEXT: Record<string, string> = {
  // Preset names
  'Flagship 4-Tier Factory': '旗舰四层工业工厂',
  'Starter 2-Tier Flow': '极简入门双层流',
  'Solo Coder 3-Tier Flow': '个人开发三层流',
  'Review-Only Audit': '只读审计流水线',
  'Claude-Only 3-Tier Flow': 'Claude 专用三层工作流',
  'Codex-Only 3-Tier Flow': 'Codex 专用三层工作流',
  'DeepSeek API Bulk Factory': 'DeepSeek API 批量工厂',

  // Preset descriptions
  'Antigravity brainstorm & final sign-off -> Claude planning & milestone gate -> Codex critical execution & micro-review -> DeepSeek API parallel bulk execution. Built for commercial full-stack projects and overnight unattended runs.':
    'Antigravity 头脑风暴与终审 → Claude 规划与里程碑把关 → Codex 核心攻坚与微审 → DeepSeek API 高并发批量执行，适合中大型商业级项目与通宵无人值守。',
  'Zero-friction, ultra-low-cost workflow. Run planning, parallel coding, automated testing, and human preview sign-off with a single affordable API/CLI.':
    '零门槛、超低成本！只需一个高性价比 API 或 CLI 即可完成规划、并发编程、自动测试和人工预览验收。',
  'Claude plans tasks, DeepSeek API implements code, and Codex reviews changes before merging for final human sign-off.':
    'Claude 拆解任务，DeepSeek API 编写代码，Codex 审校，通过测试与审校后合入分支，由用户最终验收。',
  'Read-only audit pipeline: runs automated tests and lint checks, followed by Codex security micro-review and Claude Opus architecture review. Never modifies code; hands findings to a human for final sign-off.':
    '只读审计流水线：自动运行测试与静态检查，由 Codex 做安全微审、Claude Opus 做架构评审。全程只读、不改代码，审校结论交由用户最终确认。',
  'Claude Fable plans the work. Claude Opus implements and reviews changes before merging for human sign-off.':
    'Claude Fable 规划任务，Claude Opus 实现并审查变更。变更合入后由用户验收。',
  'Codex Astra plans tasks and reviews the changes implemented by Codex Sol. Tested and reviewed changes merge for human sign-off.':
    'Codex Astra 规划任务并审查 Codex Sol 实现的变更。通过测试与审查的变更合入后由用户验收。',
  'DeepSeek API plans batches and executes them across parallel workers. Automated tests check each batch before human sign-off.':
    'DeepSeek API 划分批次，再并行执行任务。自动测试逐批验证结果，再交由用户验收。',

  // flagship_4tier nodes
  'L0 Brainstorm (Antigravity)': 'L0 头脑风暴 (Antigravity)',
  'L1 Tactical Plan (Claude Fable)': 'L1 战术拆解 (Claude Fable)',
  'Tier Router': '任务分级分流',
  'L2 Critical Specialist (Codex Sol)': 'L2 核心攻坚 (Codex Sol)',
  'L3 Bulk Workers (DeepSeek API)': 'L3 并发批量 (DeepSeek API)',
  'Mechanical Gate (Lint/Test)': '机械门禁（测试/检查）',
  'L2 Micro Review (Codex Astra)': 'L2 微观审校 (Codex Astra)',
  'Milestone Merge': '里程碑分支合入',
  'L1 Milestone Gate (Claude Opus)': 'L1 里程碑把关 (Claude Opus)',
  'L0 Final Sign-Off (Antigravity + User)': 'L0 终审验收 (Antigravity + 用户)',

  // starter_2tier nodes
  'Task Breakdown (Any Reasoning Model)': '方案拆解（任意推理模型）',
  'Parallel Worker (DeepSeek API)': '并发执行 (DeepSeek API)',
  'Automated Test Gate': '自动测试门禁',
  'Preview & Sign-Off': '预览并确认成果',

  // solo_coder_3tier nodes
  'Task Planning (Claude Fable)': '任务规划 (Claude Fable)',
  'Code Execution (DeepSeek API)': '代码实现 (DeepSeek API)',
  'Test Gate': '测试门禁',
  'Code Review (Codex Astra)': '代码审校 (Codex Astra)',
  'Branch Merge': '分支合入',
  'Human Sign-Off': '人工验收',

  // review_only_audit nodes
  'Audit Gate (Tests / Lint)': '审计门禁（测试/检查）',
  'Security Micro-Review (Codex Astra)': '安全微审 (Codex Astra)',
  'Architecture Review (Claude Opus)': '架构评审 (Claude Opus)',
  'Human Audit Sign-Off': '人工审计确认',

  // claude_only_3tier nodes
  'Code Execution (Claude Opus)': '代码实现 (Claude Opus)',
  'Code Review (Claude Opus)': '代码审校 (Claude Opus)',

  // codex_only_3tier nodes
  'Task Planning (Codex Astra)': '任务规划 (Codex Astra)',
  'Code Execution (Codex Sol)': '代码实现 (Codex Sol)',

  // deepseek_bulk_factory nodes
  'Batch Planning (DeepSeek API)': '批次规划 (DeepSeek API)',
  'Parallel Batch Workers (DeepSeek API)': '并行批量执行 (DeepSeek API)',
  'Test Changes from DeepSeek API': '测试 DeepSeek API 生成的变更',
  'DeepSeek API Batch Sign-Off': '验收 DeepSeek API 批量任务',
};

const ROLE_LABELS_EN: Record<string, string> = {
  brainstorm_and_final_gate: 'L0 Brainstorm & Final Gate',
  tactical_planner: 'L1 Tactical Planner',
  milestone_reviewer: 'L1 Milestone Reviewer',
  critical_executor: 'L2 Critical Executor',
  micro_orchestrator: 'L2 Micro Reviewer',
  bulk_worker: 'L3 Bulk Worker',
};

const ROLE_LABELS_ZH: Record<string, string> = {
  brainstorm_and_final_gate: 'L0 头脑风暴与终审',
  tactical_planner: 'L1 战术规划',
  milestone_reviewer: 'L1 里程碑审校',
  critical_executor: 'L2 核心执行',
  micro_orchestrator: 'L2 微观审校',
  bulk_worker: 'L3 并发批量执行',
};

const HANDLE_LABELS_ZH: Record<string, string> = {
  in: '输入',
  out: '输出',
  fix: '修复',
  dag: '任务图',
  rfc: '需求规格',
  critical: '核心',
  routine: '常规',
  pass: '通过',
  fail: '失败',
  minor_fix: '返修',
  escalate: '升级',
  approve: '批准',
  reject: '驳回',
};

export function translatePresetText(text: string, locale: Locale): string {
  if (locale === 'en') return text;
  return EN_TO_ZH_PRESET_TEXT[text] ?? text;
}

export function translateRole(role: string, locale: Locale): string {
  if (locale === 'en') return ROLE_LABELS_EN[role] ?? role;
  return ROLE_LABELS_ZH[role] ?? role;
}

export function formatProviderDisplay(provider: string): string {
  return provider === 'dsh_opencode' ? 'DeepSeek API' : provider;
}

export function translateHandle(handle: string, locale: Locale): string {
  if (locale === 'en') return handle;
  return HANDLE_LABELS_ZH[handle] ?? handle;
}
