import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[13px] font-medium transition-all duration-150 cursor-pointer disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:brightness-110 active:scale-[0.98]',
        secondary:
          'bg-secondary text-secondary-foreground border border-border hover:bg-[var(--panel-hover)] hover:text-text-strong',
        outline:
          'border border-border bg-card text-foreground shadow-xs hover:border-border-strong hover:bg-[var(--panel-hover)] hover:text-text-strong',
        ghost:
          'text-muted-foreground hover:bg-[var(--panel-hover)] hover:text-text-strong',
        destructive:
          'border border-rose-500/30 bg-[var(--rose-soft)] text-[var(--rose)] hover:bg-rose-500/20',
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        sm: 'h-7 rounded-md px-2.5 text-xs',
        xs: 'h-6 rounded-md px-2 text-[11px]',
        icon: 'h-8 w-8 p-0',
        'icon-sm': 'h-7 w-7 rounded-md p-0',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  },
);

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
