import type { ReactNode } from 'react';
import type { Provider } from '../types';
import { PROVIDERS } from '../lib/models';

export function FluxMark({ size = 34, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`flux-mark ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <img src="/brand-mark.svg" alt="" draggable={false} />
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
