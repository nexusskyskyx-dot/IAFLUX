import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck, X } from 'lucide-react';
import type { AppConfig, Credentials, Provider } from '../types';
import { PROVIDERS } from '../lib/models';
import { ProviderIcon } from './Brand';

interface Props {
  credentials: Credentials;
  config: AppConfig;
  focusProvider?: Provider;
  onSave: (credentials: Credentials) => void;
  onClose: () => void;
}

export default function SettingsModal({ credentials, config, focusProvider, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<Credentials>(() => ({ ...credentials, keys: { ...credentials.keys } }));
  const [visible, setVisible] = useState<Provider | 'access' | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const providers: Exclude<Provider, 'ollama'>[] = ['openrouter', 'gemini', 'groq'];
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="settings-header">
        <div className="settings-header-icon"><KeyRound size={21} strokeWidth={1.7} /></div>
        <div><div className="eyebrow">YOUR CONNECTIONS</div><h2 id="settings-title">Make it yours<span>.</span></h2><p>Bring a key from a free-tier provider to start creating.</p></div>
        <button className="icon-button settings-close" onClick={onClose} aria-label="Close settings"><X size={20} /></button>
      </div>
      <div className="settings-body">
        <div className="settings-section-heading"><span>AI PROVIDERS</span><span>01 — 03</span></div>
        {providers.map((provider) => <div key={provider} className={`settings-provider ${focusProvider === provider ? 'settings-provider-focus' : ''}`}>
          <ProviderIcon provider={provider} />
          <div className="settings-provider-content">
            <div className="settings-provider-title"><strong>{PROVIDERS[provider].name}</strong>{config.configured[provider] && !draft.keys[provider] ? <span className="settings-env-tag"><Check size={11} /> Workspace key</span> : draft.keys[provider] ? <span className="settings-connected-tag"><span /> Connected</span> : null}</div>
            <p>{PROVIDERS[provider].description}</p>
            <div className="settings-key-row">
              <input type={visible === provider ? 'text' : 'password'} value={draft.keys[provider]} onChange={(event) => setDraft((previous) => ({ ...previous, keys: { ...previous.keys, [provider]: event.target.value } }))} placeholder={config.configured[provider] ? 'Using workspace key · add your own to override' : 'Paste your API key here'} aria-label={`${PROVIDERS[provider].name} API key`} autoComplete="off" spellCheck={false} />
              <button aria-label={`${visible === provider ? 'Hide' : 'Show'} ${PROVIDERS[provider].name} key`} onClick={() => setVisible(visible === provider ? null : provider)}>{visible === provider ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </div>
            <a href={PROVIDERS[provider].url} target="_blank" rel="noreferrer">Get a {PROVIDERS[provider].name} key <ArrowUpRight size={13} /></a>
          </div>
        </div>)}
        <div className="settings-local-note"><span className="settings-local-icon">◉</span><div><strong>Prefer to keep it local?</strong><p>Set <code>OLLAMA_BASE_URL</code> on the server to discover your installed Ollama models. No API key needed.</p></div></div>
        {config.requiresAccessCode && <div className="settings-access"><label htmlFor="access-code"><LockKeyhole size={16} /> Workspace access code</label><div className="settings-key-row"><input id="access-code" type={visible === 'access' ? 'text' : 'password'} value={draft.accessCode} onChange={(event) => setDraft((previous) => ({ ...previous, accessCode: event.target.value }))} placeholder="Enter the code from your workspace owner" autoComplete="off" /><button aria-label="Show or hide access code" onClick={() => setVisible(visible === 'access' ? null : 'access')}>{visible === 'access' ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></div>}
        <label className="settings-remember"><input type="checkbox" checked={draft.remember} onChange={(event) => setDraft((previous) => ({ ...previous, remember: event.target.checked }))} /><span className="checkbox-ui"><Check size={13} /></span><span><strong>Remember on this device</strong><small>Off by default. Otherwise keys last only for this browser tab.</small></span></label>
      </div>
      <div className="settings-footer"><div><ShieldCheck size={17} /><span>Keys are sent only to your AIFLUX server and the selected provider. Never shared with other users.</span></div><button className="primary-button" onClick={() => onSave({ ...draft, keys: Object.fromEntries(Object.entries(draft.keys).map(([provider, key]) => [provider, key.trim()])) as Credentials['keys'], accessCode: draft.accessCode.trim() })}>Save connections <ArrowUpRight size={17} /></button></div>
    </div>
  </div>;
}
