import './ui.css';
import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../../i18n';
import type { ModalProps } from '../types';
import { Button } from './button';

export function canOpenModalDialog(
  open: boolean,
  dialog: (Pick<HTMLDialogElement, 'open'> & Partial<Pick<HTMLDialogElement, 'closest'>>) | null,
): boolean {
  if (!open || !dialog || dialog.open) return false;
  return typeof dialog.closest === 'function' ? dialog.closest('[hidden]') === null : true;
}

export function Modal({ open, title, wide = false, onClose, children }: ModalProps) {
  const { messages } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!canOpenModalDialog(open, dialog)) return;

    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [open]);

  return (
    <dialog
      className="modal"
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal__panel${wide ? ' modal__panel--wide' : ''} panel`}>
        <div className="modal__header">
          <h2 className="panel__title" id={titleId}>{title}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            className="modal__close"
            aria-label={messages.inspector.modalCloseAria}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
