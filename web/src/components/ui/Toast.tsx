import './ui.css';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastHostProps, ToastItem } from '../types';

const TOAST_DURATION_MS = 3000;

type TimedToast = ToastItem & { expiresAt: number };

export function useToasts(): {
  toasts: readonly ToastItem[];
  push(message: string, kind?: ToastItem['kind']): void;
} {
  const [toasts, setToasts] = useState<TimedToast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, kind: ToastItem['kind'] = 'ok') => {
    const toast: TimedToast = {
      id: nextId.current++,
      message,
      kind,
      expiresAt: Date.now() + TOAST_DURATION_MS,
    };
    setToasts((current) => [...current, toast]);
  }, []);

  useEffect(() => {
    const nextToast = toasts[0];
    if (!nextToast) return;

    const timer = setTimeout(() => {
      const now = Date.now();
      setToasts((current) => current.filter(({ expiresAt }) => expiresAt > now));
    }, Math.max(0, nextToast.expiresAt - Date.now()));

    return () => clearTimeout(timer);
  }, [toasts]);

  return { toasts, push };
}

export function ToastHost({ toasts }: ToastHostProps) {
  return (
    <div className="toast-host" aria-live="polite" aria-relevant="additions">
      {toasts.map(({ id, message, kind }) => {
        const Icon = kind === 'err' ? CircleAlert : CircleCheck;

        return (
          <div className={`toast-host__item toast-host__item--${kind}`} key={id}>
            <Icon className="toast-host__icon" size={18} aria-hidden="true" />
            <span>{message}</span>
          </div>
        );
      })}
    </div>
  );
}
