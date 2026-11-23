import './AttentionBanner.css';
import { useState } from 'react';
import { ATTENTION_TITLE_KEYS, MESSAGES, type Locale } from '../i18n/messages';
import type { AttentionCategory, RunAttentionState } from '../types/graph';
import { Button } from './ui/button';
import { Input } from './ui/input';

export type AttentionActionKind = 'approve' | 'reject' | 'resume' | 'battle_report';

const ACTIONS_BY_CATEGORY: Record<AttentionCategory, readonly AttentionActionKind[]> = {
  waiting_human: ['approve', 'reject'],
  ready_for_final_gate: ['battle_report'],
  failed: [],
  paused: ['resume'],
  long_cooldown: [],
};

export function attentionActionsFor(category: AttentionCategory): AttentionActionKind[] {
  return [...ACTIONS_BY_CATEGORY[category]];
}

export function attentionBadgeLabel(category: AttentionCategory, locale: Locale): string {
  return MESSAGES[locale].attention.badges[category];
}

export interface AttentionBannerProps {
  alert: RunAttentionState | null;
  runId: string | null;
  locale: Locale;
  notificationPermission: NotificationPermission | 'unsupported';
  busy?: boolean;
  onApprove: () => void;
  onReject: (note: string) => void;
  onResume: () => void;
  onOpenBattleReport: () => void;
  onEnableNotifications: () => void;
  onDismiss: () => void;
}

export function AttentionBanner({
  alert,
  runId,
  locale,
  notificationPermission,
  busy = false,
  onApprove,
  onReject,
  onResume,
  onOpenBattleReport,
  onEnableNotifications,
  onDismiss,
}: AttentionBannerProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState('');

  if (!alert) return null;

  const copy = MESSAGES[locale].attention;
  const title = copy[ATTENTION_TITLE_KEYS[alert.category]];
  const detail = alert.message.trim() || copy.fallbackDetails[alert.category];
  const actions = attentionActionsFor(alert.category);

  function submitReject() {
    onReject(note.trim());
    setRejectOpen(false);
    setNote('');
  }

  return (
    <section
      role="alert"
      aria-live="assertive"
      aria-busy={busy || undefined}
      className={`attention-banner attention-banner--${alert.severity} attention-banner--${alert.category}`}
      data-category={alert.category}
    >
      <div className="attention-banner__head">
        <span className="attention-banner__badge" data-category={alert.category}>
          {attentionBadgeLabel(alert.category, locale)}
        </span>
        <strong className="attention-banner__title">{title}</strong>
        {runId && (
          <code className="attention-banner__run" title={runId}>
            {runId}
          </code>
        )}
      </div>

      <p className="attention-banner__message">{detail}</p>

      <div className="attention-banner__actions">
        {actions.includes('approve') && (
          <Button variant="default" size="sm" disabled={busy} onClick={onApprove}>
            {copy.approve}
          </Button>
        )}

        {actions.includes('reject') && !rejectOpen && (
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => setRejectOpen(true)}
          >
            {copy.reject}
          </Button>
        )}

        {actions.includes('reject') && rejectOpen && (
          <div className="attention-banner__reject">
            <Input
              className="attention-banner__note"
              value={note}
              placeholder={copy.rejectNotePlaceholder}
              aria-label={copy.rejectNotePlaceholder}
              disabled={busy}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            <Button variant="destructive" size="sm" disabled={busy} onClick={submitReject}>
              {copy.reject}
            </Button>
          </div>
        )}

        {actions.includes('resume') && (
          <Button variant="default" size="sm" disabled={busy} onClick={onResume}>
            {copy.resume}
          </Button>
        )}

        {actions.includes('battle_report') && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onOpenBattleReport}>
            {copy.viewBattleReport}
          </Button>
        )}

        {notificationPermission === 'default' && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onEnableNotifications}>
            {copy.enableDesktopAlerts}
          </Button>
        )}

        {notificationPermission === 'granted' && (
          <span className="attention-banner__hint">{copy.notificationsEnabled}</span>
        )}

        {notificationPermission === 'denied' && (
          <span className="attention-banner__hint attention-banner__hint--blocked">
            {copy.notificationsBlocked}
          </span>
        )}

        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {copy.dismiss}
        </Button>
      </div>
    </section>
  );
}
