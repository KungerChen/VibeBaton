import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export interface SwitchProps extends Omit<ComponentProps<'button'>, 'onChange'> {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
}

export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...props
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-border-strong',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}
