import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Braces, Check, ChevronDown, Code2, Copy, FileCode2, Globe2, Lightbulb, Loader2, Paperclip, Send, Sparkles, Square, WandSparkles, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AttachedFile, ChatMessage, Conversation, ModelInfo, Provider, SearchMode } from '../types';
import { LogoMark, ProviderIcon } from './Brand';
import ModelPicker from './ModelPicker';
import { copyToClipboard } from '../lib/clipboard.ts';
import { MAX_CONTINUATIONS } from '../lib/continuation';

interface Props {
  conversation: Conversation;
  selectedModel: ModelInfo;
  models: ModelInfo[];
  catalogAvailable: boolean | null;
  connected: boolean;
  sending: boolean;
  searchMode: SearchMode;
  onCycleSearchMode: () => void;
  contextFile: AttachedFile | null;
  isConnected: (provider: Provider) => boolean;
  onSend: (text: string, attachments: AttachedFile[]) => boolean;
  onStop: () => void;
  onSelectModel: (model: ModelInfo) => void;
  onLoadModels: () => void;
  onLibrary: () => void;
  onOpenSnippet: (content: string, info: string) => void;
  onClearContext: () => void;
  onNotify: (message: string) => void;
  onSettings: () => void;
  onOpenFileDiff: (path: string) => void;
}

const suggestions = [
  { icon: <WandSparkles size={20} strokeWidth={1.7} />, color: 'brand', title: 'Build a website', desc: 'From idea to first version', prompt: 'Build a beautiful, responsive landing page for a creative studio. Give me one complete HTML file with CSS and a subtle interactive detail.' },
  { icon: <Braces size={20} strokeWidth={1.7} />, color: 'blue', title: 'Debug my code', desc: 'Find the issue, fix the flow', prompt: 'Help me debug this code. Explain the root cause clearly, then show the corrected version:\n\n' },
  { icon: <Lightbulb size={20} strokeWidth={1.7} />, color: 'pink', title: 'Explore an idea', desc: 'Make the what-if real', prompt: 'I have an app idea. Help me refine it, choose a simple tech stack, and map out a first version I can build.' },
  { icon: <Code2 size={20} strokeWidth={1.7} />, color: 'orange', title: 'Learn something new', desc: 'Understand it by building it', prompt: 'Explain React hooks using a small, practical example I can edit and run. Walk me through how it works.' },
];

async function copyText(text: string, onNotify: (message: string) => void) {
  const copied = await copyToClipboard(text);
  onNotify(copied ? 'Copied to clipboard' : 'Could not copy to clipboard');
}

function CodeBlock({ node, onOpenSnippet, onNotify }: { node: unknown; onOpenSnippet: Props['onOpenSnippet']; onNotify: Props['onNotify'] }) {
  const pre = node as { children?: { tagName?: string; properties?: { className?: string[] }; children?: { value?: string }[]; data?: { meta?: string } }[] };
  const code = pre.children?.find((child) => child.tagName === 'code');
  const content = code?.children?.map((child) => child.value || '').join('') || '';
  const language = code?.properties?.className?.join(' ')?.replace('language-', '') || 'code';
  const info = `${language} ${code?.data?.meta || ''}`.trim();
  const filename = info.match(/(?:filename|file|title)\s*=\s*["']?([^\s"']+)/i)?.[1];
  return <div className="markdown-code-block"><div className="markdown-code-header"><span><FileCode2 size={14} />{filename || language}</span><div><button onClick={() => copyText(content, onNotify)} title="Copy code"><Copy size={13} /> Copy</button><button onClick={() => onOpenSnippet(content, info)} title="Open code in Canvas"><ArrowUpRight size={13} /> Open in Canvas</button></div></div><pre><code>{content}</code></pre></div>;
}

function MessageBody({ message, onOpenSnippet, onNotify }: { message: ChatMessage; onOpenSnippet: Props['onOpenSnippet']; onNotify: Props['onNotify'] }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre: ({ node }) => <CodeBlock node={node} onOpenSnippet={onOpenSnippet} onNotify={onNotify} />,
    code: ({ children, className }) => <code className={className || 'inline-code'}>{children}</code>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={12} /></a>,
  }}>{message.content}</ReactMarkdown></div>;
}

function FileOpChips({ message, onOpen, onNotify }: { message: ChatMessage; onOpen: (path: string) => void; onNotify: (message: string) => void }) {
  if (!message.fileOps?.length) return null;
  return <div className="message-file-ops">{message.fileOps.map((op, index) => <button
    className={`file-op-chip ${op.status}`} key={`${op.path}-${index}`}
    title={op.status === 'failed' ? op.error : `${op.action === 'delete' ? 'Deleted' : 'Wrote'} ${op.path} — open the diff`}
    onClick={() => { if (op.status === 'failed') onNotify(op.error || 'That change could not be applied.'); else onOpen(op.path); }}
  >
    <FileCode2 size={13} />
    <span className="file-op-name">{op.path.split('/').at(-1)}</span>
    {op.status === 'failed' ? <span className="file-op-failed">failed</span>
      : op.action === 'delete' ? <span className="file-op-stat">deleted</span>
      : <span className="file-op-stat"><span className="diff-added">+{op.added}</span> <span className="diff-removed">−{op.removed}</span></span>}
    <ArrowUpRight size={12} />
  </button>)}</div>;
}

/**
 * Pages the assistant opened. Shown plainly rather than hidden: an answer built
 * from a page the user cannot see is an answer they cannot check.
 */
function BrowseChips({ message }: { message: ChatMessage }) {
  if (!message.browses?.length) return null;
  return <div className="message-browses">{message.browses.map((result, index) => {
    let host = result.url;
    try { host = new URL(result.url).hostname.replace(/^www\./, ''); } catch { /* keep the raw string */ }
    return <a
      className={`browse-chip ${result.ok ? 'ok' : 'failed'}`} key={`${result.url}-${index}`}
      href={result.url} target="_blank" rel="noopener noreferrer"
      title={result.ok ? `Read ${result.url}` : (result.error || 'Could not be read')}
    >
      {result.ok ? <Globe2 size={13} /> : <X size={13} />}
      <span className="browse-chip-host">{host}</span>
      <span className="browse-chip-state">{result.ok ? (result.title || 'read') : 'could not read'}</span>
      <ArrowUpRight size={12} />
    </a>;
  })}</div>;
}

function ContinuationNotice({ attempt }: { attempt: number }) {
  return <div className="message-continuation" role="status"><Loader2 size={14} className="continuation-spin" /> Picking the answer back up ({Math.min(attempt + 1, MAX_CONTINUATIONS + 1)} of {MAX_CONTINUATIONS + 1}) — everything written so far is kept.</div>;
}

function SearchSources({ message }: { message: ChatMessage }) {
  if (message.searchStatus) return <div className="message-search-progress" role="status"><Globe2 size={15} />{message.searchStatus === 'planning' ? 'Deciding whether live search is needed…' : `Searching the web: ${message.searchQuery || 'finding sources'}…`}</div>;
  if (message.searchSkipped) return <div className="message-search-skipped"><Globe2 size={14} /> No live web search used for this answer.</div>;
  if (!message.search) return null;
  const sources = (Array.isArray(message.search.sources) ? message.search.sources : []).flatMap((source) => {
    try {
      const url = new URL(source.url);
      return url.protocol === 'https:' ? [{ ...source, host: url.hostname }] : [];
    } catch { return []; }
  });
  return <div className="message-web-sources">
    <div className="message-web-heading"><Globe2 size={15} /><strong>LIVE WEB SEARCH</strong><span>{message.search.query}</span></div>
    {sources.length ? <div className="message-web-links">{sources.map((source, index) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" title={source.snippet}>
      <span className="message-web-number">{index + 1}</span><span><strong>{source.title}</strong><small>{source.host}{source.publishedDate ? ` · ${source.publishedDate}` : ''}</small></span><ArrowUpRight size={13} />
    </a>)}</div> : <p className="message-web-empty">No sources were found. Check any time-sensitive claims before relying on them.</p>}
  </div>;
}

export default function ChatPanel(props: Props) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const messages = props.conversation.messages;

  useEffect(() => { setDraft(''); setFiles([]); stickToBottom.current = true; }, [props.conversation.id]);
  useLayoutEffect(() => {
    if (stickToBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, messages.at(-1)?.content]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault(); textRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const attached = [...files, ...(props.contextFile ? [props.contextFile] : [])];
  const send = () => {
    if (!draft.trim() || props.sending) return;
    if (props.onSend(draft.trim(), attached)) {
      setDraft(''); setFiles([]); props.onClearContext();
      if (textRef.current) textRef.current.style.height = 'auto';
      stickToBottom.current = true;
    }
  };
  const attachFiles = async (selected: FileList | null) => {
    if (!selected) return;
    const allowed = /\.(txt|md|js|jsx|ts|tsx|json|html|css|scss|py|sh|svg|xml|yaml|yml|sql|java|go|rs)$/i;
    const room = Math.max(0, 3 - files.length - (props.contextFile ? 1 : 0));
    if (selected.length > room) props.onNotify('You can attach up to 3 files at a time.');
    const picked: AttachedFile[] = [];
    for (const file of Array.from(selected).slice(0, room)) {
      if (!allowed.test(file.name)) { props.onNotify(`${file.name} is not a supported text/code file.`); continue; }
      if (file.size > 30_000) { props.onNotify(`${file.name} is over the 30 KB attachment limit.`); continue; }
      picked.push({ name: file.name, content: await file.text() });
    }
    setFiles((previous) => [...previous, ...picked]);
    if (fileInput.current) fileInput.current.value = '';
    textRef.current?.focus();
  };
  const copyMessage = (message: ChatMessage) => {
    void copyToClipboard(message.content).then((copied) => {
      if (!copied) { props.onNotify('Could not copy to clipboard'); return; }
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(null), 1800);
    });
  };
  const nextSearchMode = { off: 'Auto', auto: 'Always', always: 'Off' }[props.searchMode];

  return <div className={`chat-panel ${messages.length ? 'has-messages' : ''}`}>
    {messages.length === 0 ? <div className="hero-scroll"><div className="welcome">
      <div className="welcome-art" aria-hidden="true"><span className="welcome-ring welcome-ring-outer" /><span className="welcome-ring welcome-ring-inner" /><span className="welcome-orbit-dot dot-one" /><span className="welcome-orbit-dot dot-two" /><span className="welcome-orbit-dot dot-three" /><span className="welcome-symbol"><LogoMark size={53} /></span><span className="welcome-art-cross cross-one">+</span><span className="welcome-art-cross cross-two">+</span></div>
      <div className="welcome-eyebrow"><span /> YOUR CREATIVE CODING SPACE <span /></div>
      <h1>Make room for<br /><em>what’s next.</em></h1>
      <p className="welcome-description">An idea, a question, a wild what-if. Whatever you’re making, let’s make it remarkable.</p>
      <div className="suggestions-heading"><span>START WITH A SPARK</span><span>01 / 04 <ArrowRight size={14} /></span></div>
      <div className="suggestion-grid">{suggestions.map((suggestion) => <button className="suggestion-card" key={suggestion.title} onClick={() => { setDraft(suggestion.prompt); textRef.current?.focus(); }}><span className={`suggestion-icon suggestion-${suggestion.color}`}>{suggestion.icon}</span><span className="suggestion-card-text"><strong>{suggestion.title}</strong><small>{suggestion.desc}</small></span><ArrowUpRight size={16} className="suggestion-arrow" /></button>)}</div>
      {!props.connected && <button className="hero-connect-link" onClick={props.onSettings}><span className="mini-spark">✳</span> New here? Connect a free model to get started <ArrowRight size={15} /></button>}
    </div></div> : <div className="messages-scroll" ref={scrollRef} onScroll={(event) => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 130; }}><div className="messages-inner"><div className="conversation-start"><span className="conversation-start-icon"><Sparkles size={18} /></span><span>A NEW CONVERSATION</span><p>Every great thing starts somewhere.</p></div>
      {messages.map((message) => <div className={`message message-${message.role}`} key={message.id}>
        <div className="message-avatar">{message.role === 'assistant' ? <LogoMark size={29} /> : <span>YOU</span>}</div>
        <div className="message-main"><div className="message-byline"><strong>{message.role === 'assistant' ? 'AIFLUX' : 'You'}</strong><span>{message.role === 'assistant' ? message.model ? message.model.split('/').at(-1)?.replace(':free', '') : 'Coding partner' : new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
          {message.role === 'assistant' && <SearchSources message={message} />}
          {message.role === 'assistant' && !message.content && message.status === 'streaming' ? <div className="thinking-line"><span className="thinking-dots"><i /><i /><i /></span> {message.searchStatus ? 'Checking live sources...' : 'Putting thoughts into motion...'}</div> : message.content ? <MessageBody message={message} onOpenSnippet={props.onOpenSnippet} onNotify={props.onNotify} /> : null}
          {message.role === 'assistant' && message.fileOps?.length ? <FileOpChips message={message} onOpen={props.onOpenFileDiff} onNotify={props.onNotify} /> : null}
          {message.role === 'assistant' && message.browses?.length ? <BrowseChips message={message} /> : null}
          {message.role === 'assistant' && message.browsing ? <div className="message-search-progress" role="status"><Loader2 size={14} className="continuation-spin" /> Opening the page…</div> : null}
          {message.role === 'assistant' && message.continuation && message.status === 'streaming' ? <ContinuationNotice attempt={message.continuation} /> : null}
          {message.attachments?.length ? <div className="message-attachments">{message.attachments.map((file, index) => <span key={`${file.name}-${index}`}><FileCode2 size={13} />{file.name}</span>)}</div> : null}
          {message.status === 'error' && <div className="message-interrupted">Response interrupted. You can try sending your message again.</div>}
          {message.truncated && message.status === 'done' && <div className="message-interrupted">This answer reached the time limit before the model finished. Ask it to continue for the rest.</div>}
          {message.role === 'assistant' && message.content && message.status !== 'streaming' && <div className="message-actions"><button onClick={() => copyMessage(message)}>{copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}{copiedId === message.id ? 'Copied' : 'Copy response'}</button></div>}
        </div>
      </div>)}
      {messages.at(-1)?.status === 'done' && messages.at(-1)?.role === 'assistant' && <div className="conversation-end"><span>✳</span> Keep the momentum going</div>}
    </div></div>}

    <div className="composer-area"><div className="composer-wrap">
      {pickerOpen && <ModelPicker models={props.models} selected={props.selectedModel} isConnected={props.isConnected} onSelect={(model) => { props.onSelectModel(model); setPickerOpen(false); }} onClose={() => setPickerOpen(false)} onLibrary={() => { setPickerOpen(false); props.onLibrary(); }} catalogAvailable={props.catalogAvailable} />}
      <div className={`composer ${props.sending ? 'composer-sending' : ''}`}>
        {attached.length > 0 && <div className="composer-attachments">{attached.map((file, index) => <span key={`${file.name}-${index}`}><FileCode2 size={14} /> <span>{file.name}</span> <button onClick={() => index < files.length ? setFiles((previous) => previous.filter((_, fileIndex) => fileIndex !== index)) : props.onClearContext()} aria-label={`Remove ${file.name}`}><X size={13} /></button></span>)}</div>}
        <textarea ref={textRef} value={draft} onChange={(event) => { setDraft(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`; }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder="Ask anything, or tell me what you want to build..." aria-label="Message AIFLUX" rows={2} maxLength={30_000} />
        <div className="composer-toolbar"><div className="composer-tools"><input ref={fileInput} type="file" hidden multiple accept=".txt,.md,.js,.jsx,.ts,.tsx,.json,.html,.css,.scss,.py,.sh,.svg,.xml,.yaml,.yml,.sql,.java,.go,.rs" onChange={(event) => void attachFiles(event.target.files)} /><button className="composer-attach" onClick={() => fileInput.current?.click()} title="Attach a code or text file" aria-label="Attach a file"><Paperclip size={18} strokeWidth={1.7} /></button><span className="toolbar-divider" /><button className="model-trigger" onClick={() => { if (!pickerOpen) props.onLoadModels(); setPickerOpen((open) => !open); }} aria-expanded={pickerOpen} aria-label={`Select model: ${props.selectedModel.name}`}><ProviderIcon provider={props.selectedModel.provider} size="small" /><span className="model-trigger-name">{props.selectedModel.shortName}</span><span className={`model-trigger-status ${props.isConnected(props.selectedModel.provider) ? 'ready' : ''}`} /><ChevronDown size={15} /></button><span className="toolbar-divider" /><button type="button" className={`composer-search composer-search-${props.searchMode}`} onClick={props.onCycleSearchMode} title={`Web search: ${props.searchMode}. Click for ${nextSearchMode}.`} aria-label={`Web search ${props.searchMode}. Switch to ${nextSearchMode}.`}><Globe2 size={16} /><span>Web</span><strong>{props.searchMode}</strong></button></div>
          {props.sending ? <button className="send-button stop-button" onClick={props.onStop} title="Stop generation" aria-label="Stop generation"><Square size={15} fill="currentColor" /></button> : <button className="send-button" onClick={send} disabled={!draft.trim()} title="Send message" aria-label="Send message"><Send size={17} strokeWidth={2} /></button>}
        </div>
      </div>
      <div className="composer-hint"><span><span className="hint-star">✳</span> {props.searchMode === 'off' ? 'Built to help you build better.' : props.searchMode === 'auto' ? 'Web search when the AI needs it.' : 'Web search on every message.'}</span><span>Enter to send <span className="hint-divider">·</span> Shift + Enter for a new line</span></div>
    </div></div>
  </div>;
}
