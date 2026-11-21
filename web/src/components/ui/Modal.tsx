import './ui.css';
import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { ModalProps } from '../types';

export function Modal({ open, title, onClose, children }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    dialog.showModal();
    return () => dialog.close();
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
      <div className="modal__panel panel">
        <div className="modal__header">
          <h2 className="panel__title" id={titleId}>{title}</h2>
          <button className="modal__close btn" type="button" aria-label="Close dialog" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
