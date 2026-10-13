import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronRight, CircleHelp, Code2, Command, MessageCircle, MoreHorizontal, PanelLeftClose, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import type { Conversation } from '../types';
import { Brand } from './Brand';

interface Props {
  chats: Conversation[];
  activeId: string | null;
  view: 'studio' | 'library';
  connected: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onView: (view: 'studio' | 'library') => void;
  onSettings: () => void;
}

function relativeDate(timestamp: number) {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  return 'Earlier';
}

export default function Sidebar(props: Props) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearching(true);
        props.onCloseMobile();
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === 'Escape') { setSearching(false); setMenuId(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onCloseMobile]);

  const filtered = [...props.chats].sort((a, b) => b.updatedAt - a.updatedAt).filter((chat) => chat.title.toLowerCase().includes(query.toLowerCase()));
  const groups = ['Today', 'Yesterday', 'This week', 'Earlier'];

  return (
    <aside className={`sidebar ${props.mobileOpen ? 'sidebar-mobile-open' : ''}`} aria-label="Main navigation">
      <div className="sidebar-top">
        <Brand />
        <button className="icon-button sidebar-close-mobile" onClick={props.onCloseMobile} aria-label="Close menu"><X size={19} /></button>
        <span className="sidebar-top-decoration"><PanelLeftClose size={17} strokeWidth={1.7} /></span>
      </div>

      <div className="sidebar-primary">
        <button className="new-chat-button" onClick={props.onNew}>
          <span className="new-chat-plus"><Plus size={18} strokeWidth={2.2} /></span>
          <span>New conversation</span>
          <span className="new-chat-shortcut">⌘⇧O</span>
        </button>
        <div className="sidebar-section-label">YOUR SPACE</div>
        <button className={`sidebar-nav-item ${props.view === 'studio' ? 'active' : ''}`} onClick={() => props.onView('studio')}>
          <Code2 size={17} strokeWidth={1.8} /> <span>Studio</span> {props.view === 'studio' && <span className="nav-active-indicator" />}
        </button>
        <button className={`sidebar-nav-item ${props.view === 'library' ? 'active' : ''}`} onClick={() => props.onView('library')}>
          <BookOpen size={17} strokeWidth={1.8} /> <span>Model library</span> <ChevronRight size={15} className="nav-chevron" />
        </button>
      </div>

      <div className="sidebar-history">
        <div className="sidebar-history-heading">
          <span>RECENTS <span className="history-count">{props.chats.length}</span></span>
          <button className="subtle-icon" onClick={() => { setSearching((value) => !value); setTimeout(() => searchRef.current?.focus(), 0); }} aria-label="Search conversations" title="Search conversations (Ctrl+K)"><Search size={16} /></button>
        </div>
        {searching && <div className="sidebar-search"><Search size={14} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a conversation..." aria-label="Search conversations" /><button onClick={() => { setSearching(false); setQuery(''); }} aria-label="Close search"><X size={13} /></button></div>}
        <div className="history-scroll">
          {filtered.length ? groups.map((group) => {
            const items = filtered.filter((chat) => relativeDate(chat.updatedAt) === group);
            if (!items.length) return null;
            return <div className="history-group" key={group}>
              <div className="history-group-label">{group}</div>
              {items.map((chat) => <div key={chat.id} className={`history-row ${props.activeId === chat.id && props.view === 'studio' ? 'selected' : ''}`}>
                <button className="history-link" onClick={() => props.onSelect(chat.id)} title={chat.title}><MessageCircle size={15} strokeWidth={1.8} /><span>{chat.title}</span></button>
                <button className="history-more" aria-label={`Options for ${chat.title}`} onClick={() => setMenuId(menuId === chat.id ? null : chat.id)}><MoreHorizontal size={15} /></button>
                {menuId === chat.id && <div className="history-menu"><button onClick={() => { props.onDelete(chat.id); setMenuId(null); }}><Trash2 size={14} /> Delete chat</button></div>}
              </div>)}
            </div>;
          }) : <div className="history-empty"><div className="history-empty-icon"><MessageCircle size={18} strokeWidth={1.5} /></div><span>{query ? 'Nothing found.' : 'Your next big idea starts here.'}</span>{!query && <small>Conversations will appear here.</small>}</div>}
        </div>
      </div>

      <div className="sidebar-bottom">
        <div className={`connect-card ${props.connected ? 'connect-card-ready' : ''}`}>
          <div className="connect-card-pattern" />
          <div className="connect-card-icon">{props.connected ? <Command size={19} /> : <span>✳</span>}</div>
          <div className="connect-card-title">{props.connected ? 'Ready when you are.' : 'Make more possible.'}</div>
          <p>{props.connected ? 'Your AI connection is set. Time to make something brilliant.' : 'Connect a free-tier model and start building without limits to your ideas.'}</p>
          <button onClick={props.onSettings}>{props.connected ? 'Manage connections' : 'Connect a model'} <ArrowUpRight size={15} /></button>
        </div>
        <div className="sidebar-bottom-links">
          <button onClick={props.onSettings}><Settings2 size={17} strokeWidth={1.7} /> Settings</button>
          <a href="https://github.com/nexusskyskyx-dot/IAFLUX" target="_blank" rel="noreferrer"><CircleHelp size={17} strokeWidth={1.7} /> About project <ArrowUpRight size={13} /></a>
        </div>
        <div className="sidebar-footer"><span className="status-dot" /> YOUR SPACE, YOUR PACE <span>V 0.1</span></div>
      </div>
    </aside>
  );
}
