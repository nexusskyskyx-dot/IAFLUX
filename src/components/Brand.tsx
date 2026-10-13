import type { ReactNode } from 'react';
import type { Provider } from '../types';
import { PROVIDERS } from '../lib/models';

export function FluxMark({ size = 34, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`flux-mark ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 36 36" width={Math.round(size * .69)} height={Math.round(size * .69)} fill="none">
        <path d="M18 2.5c1.7 8.6 6.9 13.8 15.5 15.5C24.9 19.7 19.7 24.9 18 33.5 16.3 24.9 11.1 19.7 2.5 18 11.1 16.3 16.3 11.1 18 2.5Z" fill="currentColor"/>
        <circle cx="18" cy="18" r="3.6" fill="#c8f975"/>
      </svg>
    </span>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand ${compact ? 'brand-compact' : ''}`}>
      <FluxMark size={34} />
      {!compact && <span className="brand-word">AI<span>FLUX</span><span className="brand-period">.</span></span>}
    </span>
  );
}

export function ProviderIcon({ provider, size = 'medium', children }: { provider: Provider; size?: 'small' | 'medium' | 'large'; children?: ReactNode }) {
  return <span className={`provider-icon provider-${provider} provider-icon-${size}`} aria-hidden="true">{children || PROVIDERS[provider].initial}</span>;
}
