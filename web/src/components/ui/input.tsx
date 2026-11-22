import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn('text-xs font-semibold text-muted-foreground', className)}
      {...props}
    />
  );
}

const fieldBaseClass =
  'flex w-full min-w-0 rounded-lg border border-input bg-card px-2.5 py-1.5 text-[13px] text-text-strong shadow-xs transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldBaseClass, 'h-8.5', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldBaseClass, 'min-h-[84px] py-2', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(fieldBaseClass, 'h-8.5 cursor-pointer', className)} {...props} />;
}
