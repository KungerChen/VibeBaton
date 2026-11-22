import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import { Badge, type BadgeProps } from './badge';

export function BaseNode({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      tabIndex={0}
      className={cn(
        'relative flex flex-col rounded-2xl border bg-[var(--node-bg)] text-foreground shadow-[var(--node-shadow)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

export function BaseNodeHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      className={cn('flex items-start gap-2.5 px-3.5 pt-3 pb-2', className)}
      {...props}
    />
  );
}

export function BaseNodeHeaderTitle({ className, ...props }: ComponentProps<'h3'>) {
  return (
    <h3
      className={cn(
        'm-0 text-[13px] font-semibold leading-snug text-text-strong line-clamp-2',
        className,
      )}
      {...props}
    />
  );
}

export function BaseNodeContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-1.5 px-3.5 pb-3 text-xs', className)}
      {...props}
    />
  );
}

export function BaseNodeFooter({ className, ...props }: ComponentProps<'footer'>) {
  return (
    <footer
      className={cn(
        'flex flex-col gap-1 rounded-b-2xl border-t border-border/70 bg-muted/45 px-3.5 py-2',
        className,
      )}
      {...props}
    />
  );
}

export function NodeStatusBadge({
  variant = 'secondary',
  className,
  ...props
}: BadgeProps) {
  return (
    <Badge
      variant={variant}
      className={cn('px-1.5 py-0 text-[10px] font-mono', className)}
      {...props}
    />
  );
}
