import type { ReactNode } from 'react';
import type { Provider } from '../types';
import { PROVIDERS } from '../lib/models';

/**
 * The AIFLUX mark. Served from /logo.png so it is one asset in one place —
 * public/ stays reachable on Vercel and in the built client.
 */
export function LogoMark({ size = 34, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`logo-mark ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <img src="/logo.png" alt="" width={size} height={size} decoding="async" />
    </span>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand ${compact ? 'brand-compact' : ''}`}>
      <LogoMark size={34} />
      {!compact && <span className="brand-word">AI<span>FLUX</span><span className="brand-period">.</span></span>}
    </span>
  );
}

export function ProviderIcon({ provider, size = 'medium', children }: { provider: Provider; size?: 'small' | 'medium' | 'large'; children?: ReactNode }) {
  return <span className={`provider-icon provider-${provider} provider-icon-${size}`} aria-hidden="true">{children || PROVIDERS[provider].initial}</span>;
}
