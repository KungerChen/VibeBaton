import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-tight transition-colors',
  {
    variants: {
      variant: {
        default: 'border-primary/25 bg-[var(--accent-soft)] text-accent-foreground',
        secondary: 'border-border bg-secondary text-secondary-foreground',
        outline: 'border-border-strong bg-transparent text-muted-foreground',
        success: 'border-emerald-500/30 bg-[var(--emerald-soft)] text-[var(--emerald)]',
        warning: 'border-amber-500/35 bg-[var(--amber-soft)] text-[var(--amber)]',
        destructive: 'border-rose-500/35 bg-[var(--rose-soft)] text-[var(--rose)]',
        info: 'border-sky-500/30 bg-[var(--sky-soft)] text-[var(--sky)]',
        violet: 'border-violet-500/30 bg-violet-500/12 text-[var(--violet)]',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
