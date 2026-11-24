import { useId } from 'react';

export interface BrandMarkProps {
  size?: number;
  className?: string;
}

/** Inline relay-baton brand mark matching the VibeBaton browser favicon. */
export function BrandMark({ size = 18, className }: BrandMarkProps) {
  const rawId = useId().replace(/:/g, '');
  const badgeId = `${rawId}-badge`;
  const batonId = `${rawId}-baton`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={badgeId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
        <linearGradient id={batonId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".6" stopColor="#ffffff" />
          <stop offset="1" stopColor="#86efac" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${badgeId})`} />
      <rect x=".5" y=".5" width="31" height="31" rx="7.5" fill="none" stroke="#ffffff" strokeOpacity=".18" />
      <g transform="rotate(-32 16 16)">
        <rect x="5" y="12.25" width="22" height="7.5" rx="3.75" fill={`url(#${batonId})`} />
        <path d="M9.5 16h3.5" stroke="#1e3a8a" strokeOpacity=".32" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    </svg>
  );
}
