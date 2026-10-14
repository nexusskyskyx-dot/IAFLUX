import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Search, Sparkles, X } from 'lucide-react';
import type { ModelInfo, Provider } from '../types';
import { groupModels, PROVIDERS } from '../lib/models';
import { ProviderIcon } from './Brand';

interface Props {
  models: ModelInfo[];
  selected: ModelInfo;
  isConnected: (provider: Provider) => boolean;
  onSelect: (model: ModelInfo) => void;
  onClose: () => void;
  onLibrary: () => void;
  catalogAvailable: boolean | null;
}

export default function ModelPicker({ models, selected, isConnected, onSelect, onClose, onLibrary, catalogAvailable }: Props) {
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onPointer = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as Element).closest('.model-trigger')) onClose(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onPointer); };
  }, [onClose]);
  const filtered = models.filter((model) => `${model.name} ${model.id} ${model.strength}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="model-picker" ref={ref} role="dialog" aria-label="Choose an AI model">
    <div className="model-picker-header"><span>CHOOSE YOUR MODEL</span><button className="subtle-icon" onClick={onClose} aria-label="Close model picker"><X size={16} /></button></div>
    <div className="model-picker-search"><Search size={16} /><input ref={inputRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search available models..." aria-label="Search models" /><span>ESC</span></div>
    <div className="model-picker-scroll">
      {filtered.length ? groupModels(filtered).map(({ provider, models: items }) => <div key={provider} className="picker-group">
        <div className="picker-group-title">{PROVIDERS[provider].name}<span>{items.length}</span></div>
        {items.map((model) => <button key={`${model.provider}:${model.id}`} className={`picker-model ${selected.id === model.id && selected.provider === model.provider ? 'picker-model-selected' : ''}`} onClick={() => onSelect(model)}>
          <ProviderIcon provider={model.provider} size="small" />
          <span className="picker-model-copy"><strong>{model.name}</strong><small>{model.strength} · {model.badge.toLowerCase()}</small></span>
          {selected.id === model.id && selected.provider === model.provider ? <Check size={16} className="picker-check" /> : <span className={`picker-connection ${isConnected(model.provider) ? 'is-on' : ''}`} title={isConnected(model.provider) ? 'Connected' : 'Needs connection'} />}
        </button>)}
      </div>) : <div className="picker-no-results"><Sparkles size={20} /> No models match “{search}”</div>}
    </div>
    <button className="picker-footer" onClick={onLibrary}><span><Sparkles size={16} /> Explore the model library</span><span>{catalogAvailable === false ? 'Catalog offline' : 'Discover more'} <ArrowRight size={15} /></span></button>
  </div>;
}
