import type { AttentionCategory } from '../types/graph';
import { ATTENTION_TITLE_KEYS, MESSAGES, type Locale } from './messages';
import { formatProviderDisplay, translateRole } from './presets';

const CJK_REGEX = /[\u4e00-\u9fff]/;

const EVENT_KIND_LABELS: Record<string, { en: string; zh: string }> = {
  run_created: { en: 'Run Created', zh: '创建运行' },
  plan_generated: { en: 'Plan Generated', zh: '生成计划' },
  plan_registered: { en: 'Plan Registered', zh: '注册任务图' },
  role_invoked: { en: 'Role Invoked', zh: '调用角色' },
  role_completed: { en: 'Role Completed', zh: '角色完成' },
  task_model_allocated: { en: 'Model Allocated', zh: '模型配给' },
  task_step_up: { en: 'Step-Up Escalation', zh: '智能升档' },
  budget_profile_changed: { en: 'Budget Profile', zh: '预算档位变更' },
  task_started: { en: 'Task Started', zh: '任务开始' },
  task_passed: { en: 'Task Passed', zh: '任务通过' },
  task_failed: { en: 'Task Failed', zh: '任务失败' },
  task_exec_error: { en: 'Execution Error', zh: '执行异常' },
  task_escalated: { en: 'Task Escalated', zh: '熔断升级' },
  task_review_passed: { en: 'Review Passed', zh: '审校通过' },
  task_review_rejected: { en: 'Review Rejected', zh: '审校退回' },
  mechanical_gate_caught: { en: 'Gate Caught', zh: '门禁拦截' },
  whitelist_violation: { en: 'Whitelist Reverted', zh: '越界回滚' },
  quota_rate_limited: { en: 'Quota Cooldown', zh: '限流冷却' },
  milestone_passed: { en: 'Milestone Passed', zh: '里程碑通过' },
  milestone_rejected: { en: 'Milestone Rejected', zh: '里程碑退回' },
  milestone_fix_applied: { en: 'Fix Applied', zh: '应用修复' },
  ready_for_final_gate: { en: 'Ready for Sign-Off', zh: '待终审合入' },
  run_paused: { en: 'Run Paused', zh: '运行暂停' },
  run_resumed: { en: 'Run Resumed', zh: '运行恢复' },
  human_resolved: { en: 'Human Resolved', zh: '人工裁决' },
  run_completed: { en: 'Run Completed', zh: '运行完成' },
  run_failed: { en: 'Run Failed', zh: '运行失败' },
  event: { en: 'Event', zh: '系统事件' },
};

const TIER_LABELS: Record<string, { en: string; zh: string }> = {
  critical: { en: 'Critical', zh: '核心' },
  routine: { en: 'Routine', zh: '常规' },
};

const CLI_REASON_ZH: Record<string, string> = {
  timeout: '超时',
  stalled: '无响应阻塞',
  nonzero_exit: '非零退出码',
  missing_binary: '未找到命令',
};

const MERGE_CONFLICT_REASONS_ZH = new Map([
  ['resolver failed', '冲突解决器执行失败'],
  ['resolution attempts exhausted', '已达冲突解决尝试上限'],
  ['gate checker failed', '门禁检查执行失败'],
  ['gate rejected resolution', '冲突解决结果未通过门禁'],
]);

const MODE_LABELS_ZH: Record<string, string> = {
  overnight: '通宵无人值守',
  interactive: '交互式',
};

const FALLBACK_SUMMARY_BY_KIND: Record<string, { en: string; zh: string }> = {
  task_review_passed: { en: 'Micro-review passed', zh: '微观审校通过' },
  task_review_rejected: { en: 'Review requested fixes', zh: '微观审校退回修复' },
  milestone_passed: { en: 'Milestone review passed', zh: '里程碑审校通过' },
  milestone_rejected: { en: 'Milestone review requested fixes', zh: '里程碑审校退回（需修复）' },
  plan_generated: { en: 'Execution plan saved', zh: '执行计划已生成' },
  plan_registered: { en: 'Execution plan registered', zh: '执行计划已注册' },
  run_created: { en: 'Run initialized', zh: '运行已初始化' },
  task_exec_error: { en: 'Worker execution failed', zh: '执行器运行异常' },
  ready_for_final_gate: { en: 'All milestones passed; awaiting final gate sign-off', zh: '全部里程碑通过，等待 L0 终审合入' },
};

export type FormattedLiveEvent = {
  summary: string;
  rawDetail?: string;
};

type MergeConflictEventKind = keyof typeof MESSAGES.en.inspector.mergeConflictEventKinds;

function isMergeConflictEventKind(kind: string): kind is MergeConflictEventKind {
  return Object.hasOwn(MESSAGES.en.inspector.mergeConflictEventKinds, kind);
}

export function translateEventKind(kind: string, locale: Locale): string {
  if (isMergeConflictEventKind(kind)) return MESSAGES[locale].inspector.mergeConflictEventKinds[kind];
  if (kind === 'human_attention_required') return MESSAGES[locale].attention.humanAttentionRequired;
  const entry = EVENT_KIND_LABELS[kind];
  if (entry) return entry[locale];
  return locale === 'en' ? kind.replace(/_/g, ' ') : kind;
}

export function translateTier(tier: string, locale: Locale): string {
  const entry = TIER_LABELS[tier.toLowerCase()];
  return entry ? entry[locale] : tier;
}

function readEventPayload(payload: unknown): Record<string, unknown> {
  let data = payload;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

function formatMergeConflictMessage(
  kind: MergeConflictEventKind,
  message: string,
  locale: Locale,
  payload: unknown,
): FormattedLiveEvent {
  const { conflicted_files, source_branch, target_branch, reason } = readEventPayload(payload);
  const parts = [MESSAGES[locale].inspector.mergeConflictEventKinds[kind]];

  if (Array.isArray(conflicted_files)) {
    const count = conflicted_files.length;
    parts.push(locale === 'en'
      ? `${count} conflicted ${count === 1 ? 'file' : 'files'}`
      : `${count} 个冲突文件`);
  }

  const branches = [source_branch, target_branch]
    .filter((branch) => typeof branch === 'string' && branch.trim())
    .join(' → ');
  if (branches) parts.push(branches);

  if (typeof reason === 'string' && reason.trim()) {
    const detail = reason.trim();
    parts.push(locale === 'zh' ? MERGE_CONFLICT_REASONS_ZH.get(detail) ?? detail : detail);
  }

  return { summary: parts.join(' · '), ...(message ? { rawDetail: message } : {}) };
}

function formatAttentionMessage(message: string, locale: Locale, payload: unknown): FormattedLiveEvent {
  const { category, title } = readEventPayload(payload);
  const attention = MESSAGES[locale].attention;
  const knownCategory = typeof category === 'string' && Object.hasOwn(ATTENTION_TITLE_KEYS, category)
    ? category as AttentionCategory
    : null;
  const badge = knownCategory ? attention.badges[knownCategory] : attention.humanAttentionRequired;
  const fallbackTitle = knownCategory ? attention[ATTENTION_TITLE_KEYS[knownCategory]] : '';
  const payloadTitle = typeof title === 'string' ? title.trim() : '';
  return {
    summary: [badge, payloadTitle || fallbackTitle].filter(Boolean).join(' · '),
    ...(message ? { rawDetail: message } : {}),
  };
}

function formatProviderReferences(message: string): string {
  return message.replace(
    /(?<![\w./\\-])dsh_(?:opencode|deepseek)(?![\w-]|\.\w)/gi,
    (provider: string) => formatProviderDisplay(provider.toLowerCase()),
  );
}

/** Structured events accept a decoded payload or the snapshot's payload_json string. */
export function formatLiveEventMessage(
  kind: string,
  rawMessage: string,
  locale: Locale,
  payload?: unknown,
): FormattedLiveEvent {
  const trimmed = rawMessage.trim();
  if (isMergeConflictEventKind(kind)) {
    return formatMergeConflictMessage(kind, trimmed, locale, payload);
  }
  if (kind === 'human_attention_required') {
    return formatAttentionMessage(trimmed, locale, payload);
  }
  if (!trimmed) {
    const fallback = FALLBACK_SUMMARY_BY_KIND[kind]?.[locale];
    return { summary: fallback ?? (locale === 'en' ? 'Event recorded' : '已记录事件') };
  }

  let match = /^Invoking\s+([a-z0-9_]+)\s*\(([^)]+)\)\s*$/i.exec(trimmed);
  if (match) {
    const [, role, target] = match;
    const roleLabel = translateRole(role, locale);
    const displayTarget = formatProviderReferences(target);
    return {
      summary: locale === 'en'
        ? `Invoking ${roleLabel} (${displayTarget})`
        : `调用 ${roleLabel}（${displayTarget}）`,
    };
  }

  match = /^Completed\s+([a-z0-9_]+)\s*\(([^)]+)\)\s+in\s+([\d.]+)s(?:\s*\(([^)]+)\))?\s*$/i.exec(trimmed);
  if (match) {
    const [, role, target, durationSec, statusLabel] = match;
    const roleLabel = translateRole(role, locale);
    const displayTarget = formatProviderReferences(target);
    const statusSuffix = statusLabel ? ` · ${statusLabel}` : '';
    return {
      summary: locale === 'en'
        ? `Completed ${roleLabel} (${displayTarget}) in ${durationSec}s${statusSuffix}`
        : `完成 ${roleLabel}（${displayTarget}），用时 ${durationSec} 秒${statusSuffix}`,
    };
  }

  match = /^Run created in\s+(\S+)\s+mode$/i.exec(trimmed);
  if (match) {
    const [, mode] = match;
    return {
      summary: locale === 'en'
        ? trimmed
        : `已创建运行（${MODE_LABELS_ZH[mode] ?? mode}模式）`,
    };
  }

  match = /^Registered\s+(\d+)\s+milestone\(s\)\s+and\s+(\d+)\s+task\(s\)$/i.exec(trimmed);
  if (match) {
    const [, milestones, tasks] = match;
    return {
      summary: locale === 'en' ? trimmed : `已注册 ${milestones} 个里程碑与 ${tasks} 个任务`,
    };
  }

  match = /^Plan saved to\s+(.+)$/i.exec(trimmed);
  if (match) {
    const [, path] = match;
    return {
      summary: locale === 'en' ? trimmed : `执行计划已保存至 ${path}`,
    };
  }

  match = /^Task\s+(\S+)\s+merged into\s+(.+)$/i.exec(trimmed);
  if (match) {
    const [, taskId, branch] = match;
    return {
      summary: locale === 'en' ? trimmed : `任务 ${taskId} 已合入分支 ${branch}`,
    };
  }

  match = /^Milestone\s+(\S+)\s+merged into\s+(.+)$/i.exec(trimmed);
  if (match) {
    const [, milestoneId, branch] = match;
    return {
      summary: locale === 'en' ? trimmed : `里程碑 ${milestoneId} 已合入分支 ${branch}`,
    };
  }

  match = /^Applied remediation round\s+(\d+)\s+onto\s+(.+)$/i.exec(trimmed);
  if (match) {
    const [, round, branch] = match;
    return {
      summary: locale === 'en' ? trimmed : `已对分支 ${branch} 应用第 ${round} 轮修复`,
    };
  }

  match = /^Escalated to\s+([a-z0-9_]+)$/i.exec(trimmed);
  if (match) {
    const [, role] = match;
    const roleLabel = translateRole(role, locale);
    return {
      summary: locale === 'en' ? `Escalated to ${roleLabel}` : `已升级移交至 ${roleLabel}`,
    };
  }

  match = /^All\s+(\d+)\s+milestone\(s\)\s+passed mechanical gates and AI reviews and are merged into\s+'([^']+)'\.\s*Ready for L0 final gate review before merging to\s+'([^']+)'\.?$/i.exec(trimmed);
  if (match) {
    const [, count, devBranch, baseBranch] = match;
    return {
      summary: locale === 'en'
        ? trimmed
        : `全部 ${count} 个里程碑已通过机械门禁与 AI 审校并合入 '${devBranch}'，等待 L0 终审合入 '${baseBranch}'`,
    };
  }

  match = /^CLI execution failed\s*\(([^)]+)\)(?::\s*([\s\S]*))?$/i.exec(trimmed);
  if (match) {
    const [, reason, detail] = match;
    const reasonZh = CLI_REASON_ZH[reason] ?? reason;
    const hasDetail = Boolean(detail && detail.trim());
    return {
      summary: locale === 'en' ? `CLI execution failed (${reason})` : `CLI 执行失败（${reasonZh}）`,
      ...(hasDetail ? { rawDetail: trimmed } : {}),
    };
  }

  match = /^MINOR_FIX\s*\(#(\d+)\):\s*([\s\S]*)$/i.exec(trimmed);
  if (match) {
    const [, round, note] = match;
    const hasCjk = CJK_REGEX.test(note);
    if (locale === 'en' && hasCjk) {
      return {
        summary: `Review requested minor fix (#${round})`,
        rawDetail: trimmed,
      };
    }
    if (locale === 'zh' && !hasCjk) {
      return {
        summary: `审校退回修改（第 ${round} 轮）`,
        rawDetail: trimmed,
      };
    }
    return {
      summary: locale === 'en' ? `Minor fix (#${round}): ${note}` : `审校退回修改（第 ${round} 轮）：${note}`,
    };
  }

  const containsCjk = CJK_REGEX.test(trimmed);
  if (locale === 'en' && containsCjk) {
    return {
      summary: FALLBACK_SUMMARY_BY_KIND[kind]?.en ?? 'Original non-English note recorded',
      rawDetail: trimmed,
    };
  }

  const displayMessage = formatProviderReferences(trimmed);
  if (locale === 'zh' && !containsCjk) {
    if (displayMessage !== trimmed && !/\s/.test(trimmed)) {
      return { summary: displayMessage };
    }
    return {
      summary: FALLBACK_SUMMARY_BY_KIND[kind]?.zh ?? '事件详情（英文原文）',
      rawDetail: trimmed,
    };
  }

  return { summary: displayMessage };
}
