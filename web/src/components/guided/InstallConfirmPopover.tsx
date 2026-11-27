import { useEffect, useId, useRef } from 'react';
import type { CliDriver } from '../../api/client';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import './InstallConfirmPopover.css';

export interface InstallConfirmPopoverProps {
  driver: CliDriver;
  open: boolean;
  busy: boolean;
  error?: string | null;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * A presentational inline confirmation: the parent owns the install call and
 * only an explicit Confirm can start it. Escape and outside clicks cancel.
 */
export function InstallConfirmPopover({
  driver,
  open,
  busy,
  error,
  onConfirm,
  onCancel,
}: InstallConfirmPopoverProps) {
  const { messages } = useI18n();
  const copy = messages.guided.m3.installConfirm;
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const command = driver.install_cmd.join(' ');
  const failure = error?.trim() || null;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onCancel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="guided-install-confirm" ref={rootRef}>
      <div
        className="guided-install-confirm__panel"
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
      >
        <h2 className="guided-install-confirm__title" id={titleId}>{copy.title}</h2>
        <p className="guided-install-confirm__description" id={descriptionId}>{copy.description}</p>
        <p className="guided-install-confirm__command-label">{copy.command}</p>
        <pre className="guided-install-confirm__command"><code>{command}</code></pre>
        {failure ? (
          <p className="guided-install-confirm__error" role="alert">
            {copy.failed} {failure}
          </p>
        ) : null}
        <div className="guided-install-confirm__actions">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {copy.cancel}
          </Button>
          <Button variant="default" size="sm" disabled={busy} onClick={onConfirm}>
            {busy ? copy.installing : copy.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
