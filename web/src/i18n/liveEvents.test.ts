import { describe, expect, test } from 'vitest';
import { formatLiveEventMessage, translateEventKind, translateTier } from './liveEvents';

const CJK_REGEX = /[\u4e00-\u9fff]/;

const REAL_STAGE2_SAMPLES: readonly { kind: string; message: string }[] = [
  { kind: 'run_created', message: 'Run created in overnight mode' },
  { kind: 'role_invoked', message: 'Invoking tactical_planner (claude_sub/fable@high)' },
  { kind: 'plan_registered', message: 'Registered 3 milestone(s) and 15 task(s)' },
  { kind: 'plan_generated', message: 'Plan saved to D:\\Projects\\VibeBaton\\.baton\\runs\\run-1\\01_PLAN.dag.json' },
  { kind: 'role_invoked', message: 'Invoking critical_executor (codex_sub/gpt-6.2-sol@max)' },
  { kind: 'role_invoked', message: 'Invoking bulk_worker (dsh_opencode/deepseek-v4.1-flash@max)' },
  { kind: 'task_passed', message: 'Task M1-T1 merged into milestone/e815d5-m1' },
  {
    kind: 'milestone_rejected',
    message: "M2 delivers what the RFC asks for: the Vite/TS/Vitest config (base './'), graph types, and presets.",
  },
  { kind: 'milestone_fix_applied', message: 'Applied remediation round 1 onto milestone/e815d5-m2' },
  { kind: 'milestone_passed', message: 'Milestone M2 merged into dev' },
  {
    kind: 'task_review_rejected',
    message: 'MINOR_FIX (#1): 场景顺序、播放控件、倍速切换符合契约，唯一阻塞项是键盘方向键绕过禁用检查。',
  },
  {
    kind: 'task_review_passed',
    message: 'PlaybackBar 遵循现有 PlaybackBarProps，三个场景按顺序显示，组件测试全部通过。',
  },
  {
    kind: 'task_exec_error',
    message: 'CLI execution failed (timeout): dsh: reasoning:\nLet me start by exploring the workspace.',
  },
  { kind: 'task_escalated', message: 'Escalated to critical_executor' },
  {
    kind: 'ready_for_final_gate',
    message: "All 3 milestone(s) passed mechanical gates and AI reviews and are merged into 'dev'. Ready for L0 final gate review before merging to 'main'.",
  },
];

describe('liveEvents i18n', () => {
  test('English mode produces zero CJK characters across all real Stage 2 events while preserving rawDetail', () => {
    for (const sample of REAL_STAGE2_SAMPLES) {
      const kindEn = translateEventKind(sample.kind, 'en');
      const formattedEn = formatLiveEventMessage(sample.kind, sample.message, 'en');

      expect(kindEn, sample.kind).not.toMatch(CJK_REGEX);
      expect(formattedEn.summary, `${sample.kind}: ${formattedEn.summary}`).not.toMatch(CJK_REGEX);

      if (CJK_REGEX.test(sample.message)) {
        expect(formattedEn.rawDetail).toBe(sample.message);
      }
    }

    expect(translateTier('critical', 'en')).toBe('Critical');
    expect(translateTier('routine', 'en')).toBe('Routine');
    expect(formatLiveEventMessage('role_invoked', 'Invoking bulk_worker (dsh_opencode/deepseek-v4.1-flash@max)', 'en').summary).toContain('DeepSeek API/deepseek-v4.1-flash@max');
    expect(formatLiveEventMessage('role_invoked', 'Invoking bulk_worker (dsh_opencode/deepseek-v4.1-flash@max)', 'zh').summary).toContain('DeepSeek API/deepseek-v4.1-flash@max');
    expect(translateEventKind('role_completed', 'en')).toBe('Role Completed');
    expect(translateEventKind('role_completed', 'zh')).toBe('角色完成');
    expect(
      formatLiveEventMessage('role_completed', 'Completed bulk_worker (dsh_opencode/deepseek-v4.1-flash@max) in 42.3s (OK)', 'zh').summary,
    ).toContain('DeepSeek API/deepseek-v4.1-flash@max');
  });

  test('Chinese mode localizes all engine event kinds and messages without leaking English phrases', () => {
    for (const sample of REAL_STAGE2_SAMPLES) {
      const kindZh = translateEventKind(sample.kind, 'zh');
      const formattedZh = formatLiveEventMessage(sample.kind, sample.message, 'zh');

      expect(kindZh, sample.kind).toMatch(CJK_REGEX);
      expect(formattedZh.summary, `${sample.kind}: ${formattedZh.summary}`).toMatch(CJK_REGEX);
      expect(formattedZh.summary).not.toMatch(/Invoking|merged into|Escalated to|MINOR_FIX|Applied remediation|Run created/i);
    }

    expect(translateTier('critical', 'zh')).toBe('核心');
    expect(translateTier('routine', 'zh')).toBe('常规');
  });

  test.each([
    {
      kind: 'merge_conflict_detected',
      enLabel: 'Merge Conflict Detected',
      zhLabel: '检测到合并冲突',
      enSummary: 'Merge Conflict Detected · 2 conflicted files · task/merge-work → dev',
      zhSummary: '检测到合并冲突 · 2 个冲突文件 · task/merge-work → dev',
    },
    {
      kind: 'merge_conflict_resolved',
      enLabel: 'Merge Conflict Resolved',
      zhLabel: '合并冲突已解决',
      enSummary: 'Merge Conflict Resolved · 2 conflicted files · task/merge-work → dev',
      zhSummary: '合并冲突已解决 · 2 个冲突文件 · task/merge-work → dev',
    },
    {
      kind: 'merge_conflict_failed',
      reason: 'resolution attempts exhausted',
      enLabel: 'Merge Conflict Resolution Failed',
      zhLabel: '合并冲突解决失败',
      enSummary: 'Merge Conflict Resolution Failed · 2 conflicted files · task/merge-work → dev · resolution attempts exhausted',
      zhSummary: '合并冲突解决失败 · 2 个冲突文件 · task/merge-work → dev · 已达冲突解决尝试上限',
    },
  ])('localizes $kind with the file count and branch names', ({ kind, reason, enLabel, zhLabel, enSummary, zhSummary }) => {
    const payload = {
      conflicted_files: ['src/graph.ts', 'src/messages.ts'],
      source_branch: 'task/merge-work',
      target_branch: 'dev',
      reason,
    };

    expect(translateEventKind(kind, 'en')).toBe(enLabel);
    expect(translateEventKind(kind, 'zh')).toBe(zhLabel);
    expect(formatLiveEventMessage(kind, '', 'en', payload).summary).toBe(enSummary);
    expect(formatLiveEventMessage(kind, '', 'zh', payload).summary).toBe(zhSummary);
  });

  test('formats serialized conflict payloads from a live snapshot and preserves the original note', () => {
    const rawMessage = 'Squash merge failed in task/merge-work';
    const payloadJson = JSON.stringify({ conflicted_files: ['src/graph.ts'], reason: 'gate rejected resolution' });

    expect(formatLiveEventMessage('merge_conflict_failed', rawMessage, 'en', payloadJson)).toEqual({
      summary: 'Merge Conflict Resolution Failed · 1 conflicted file · gate rejected resolution',
      rawDetail: rawMessage,
    });
    expect(formatLiveEventMessage('merge_conflict_failed', rawMessage, 'zh', payloadJson)).toEqual({
      summary: '合并冲突解决失败 · 1 个冲突文件 · 冲突解决结果未通过门禁',
      rawDetail: rawMessage,
    });
  });

  test('uses the localized conflict label for missing or malformed payloads', () => {
    expect(formatLiveEventMessage('merge_conflict_detected', '', 'en')).toEqual({
      summary: 'Merge Conflict Detected',
    });
    expect(formatLiveEventMessage('merge_conflict_detected', 'Merge conflict in task/merge-work', 'zh', '{')).toEqual({
      summary: '检测到合并冲突',
      rawDetail: 'Merge conflict in task/merge-work',
    });
  });
});
