import { useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Code2, Filter, RefreshCw, Search, Sparkles, Zap } from 'lucide-react';
import type { ModelInfo, Provider } from '../types';
import { PROVIDERS } from '../lib/models';
import { ProviderIcon } from './Brand';

interface Props {
  models: ModelInfo[];
  selected: ModelInfo;
  catalogAvailable: boolean | null;
  isConnected: (provider: Provider) => boolean;
  onSelect: (model: ModelInfo) => void;
  onSettings: (provider?: Provider) => void;
  onRefresh: () => void;
}

type FilterName = 'All models' | 'Coding' | 'OpenRouter' | 'Gemini' | 'Groq' | 'Local';

export default function ModelLibrary({ models, selected, catalogAvailable, isConnected, onSelect, onSettings, onRefresh }: Props) {
  const [filter, setFilter] = useState<FilterName>('All models');
  const [search, setSearch] = useState('');
  const filters: FilterName[] = ['All models', 'Coding', 'OpenRouter', 'Gemini', 'Groq', 'Local'];
  const visible = useMemo(() => models.filter((model) => {
    const matches = `${model.name} ${model.id} ${model.description} ${model.strength}`.toLowerCase().includes(search.toLowerCase());
    const group = filter === 'All models' ||
      (filter === 'Coding' && (/cod|devstral|laguna|software.engineer|qwen|inkling/i.test(`${model.name} ${model.id} ${model.strength}`) || ['gemini-2.5-flash', 'openai/gpt-oss-120b'].includes(model.id))) ||
      (filter === 'Local' && model.provider === 'ollama') ||
      (filter !== 'Coding' && filter !== 'Local' && model.provider === filter.toLowerCase());
    return matches && group;
  }), [models, filter, search]);

  return <div className="library-scroll">
    <div className="library-inner">
      <div className="library-hero">
        <div className="library-hero-decoration"><span className="library-orbit one" /><span className="library-orbit two" /><span className="library-orbit-star">✳</span></div>
        <div className="eyebrow"><span className="eyebrow-line" /> THE MODEL LIBRARY</div>
        <h1>Find your <em>flow.</em></h1>
        <p>Different minds for different moments. Explore free models and free-tier APIs, then pick the right one for what you're building.</p>
        <div className="library-hero-stat"><span className="library-stat-dot" /><strong>{models.length}</strong> models to explore <span className="library-stat-divider" /> <span>One creative workspace</span></div>
      </div>
      <div className="library-controls"><div className="library-control-heading"><div><span className="section-eyebrow">THE COLLECTION</span><h2>Explore models <span>({models.length})</span></h2></div><div className="library-live"><span className={`status-dot ${catalogAvailable === false ? 'status-amber' : ''}`} />{catalogAvailable === false ? 'Live catalog unavailable' : catalogAvailable === null ? 'Checking live catalog' : 'Live free catalog'}<button onClick={onRefresh} title="Refresh free-model catalog" aria-label="Refresh free-model catalog"><RefreshCw size={14} /></button></div></div>
        <div className="library-toolbar"><div className="library-filters"><Filter size={15} />{filters.map((item) => <button key={item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="library-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models..." aria-label="Search models" /></div></div>
      </div>
      {visible.length ? <div className="library-grid">{visible.map((model) => {
        const connected = isConnected(model.provider);
        const chosen = selected.id === model.id && selected.provider === model.provider;
        return <div className={`library-card ${chosen ? 'library-card-chosen' : ''} ${model.badge.startsWith('BEST') ? 'library-card-featured' : ''}`} key={`${model.provider}:${model.id}`}>
          <div className="library-card-top"><ProviderIcon provider={model.provider} size="large" /><span className="library-card-badge">{model.badge}</span></div>
          <div className="library-card-provider">{PROVIDERS[model.provider].name} {connected && <span className="library-provider-on"><span /> Connected</span>}</div>
          <h3>{model.name}</h3><p>{model.description}</p>
          <div className="library-card-foot"><span>{model.strength === 'Coding focused' ? <Code2 size={15} /> : model.strength.includes('Fast') ? <Zap size={15} /> : <Sparkles size={15} />}{model.strength}</span><button onClick={() => onSelect(model)}>{chosen ? <><Check size={15} /> Selected</> : <>Use model <ArrowRight size={15} /></>}</button></div>
        </div>;
      })}</div> : <div className="library-empty"><Search size={26} /><h3>No models found</h3><p>Try a different search or filter. New free models appear as providers add them.</p><button onClick={() => { setSearch(''); setFilter('All models'); }}>Clear filters</button></div>}
      <div className="library-bottom-note"><div className="library-bottom-icon">✳</div><div><strong>Good to know</strong><p>“Free” means a free model variant or free-tier access—not unlimited usage. Safety classifiers, embedding, and reranking endpoints are excluded: choose a chat model for coding. Availability, data use, and rate limits vary by provider.</p></div><button onClick={() => onSettings()}>Manage connections <ArrowUpRight size={16} /></button></div>
    </div>
  </div>;
}
