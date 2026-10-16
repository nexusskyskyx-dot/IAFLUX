import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, Code2, Copy, Eye, FileCode2, FileDiff, FilePlus2, Files, FolderOpen, Github, Globe2, MoreHorizontal, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import type { Conversation, WorkspaceFile } from '../types';
import { buildPreview, downloadFile, downloadProject, fileColor, fileLanguage, safeFilename } from '../lib/files';
import CanvasDiff from './CanvasDiff';

interface Props {
  conversation: Conversation;
  mobileOpen: boolean;
  onClose: () => void;
  onSelectFile: (id: string) => void;
  onUpdateFile: (id: string, content: string) => void;
  onRestoreFile: (id: string) => void;
  onCreateFile: (name: string, content?: string) => void;
  onDeleteFile: (id: string) => void;
  onAddContext: (file: WorkspaceFile) => void;
  onNotify: (message: string) => void;
  onPublishGitHub: () => void;
}

type CanvasMode = 'view' | 'edit' | 'test' | 'diff';

const CodeEditor = lazy(() => import('./CodeEditor'));

export default function Canvas(props: Props) {
  const [mode, setMode] = useState<CanvasMode>('edit');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [remoteImagesAllowed, setRemoteImagesAllowed] = useState(false);
  const [copied, setCopied] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const file = props.conversation.files.find((item) => item.id === props.conversation.selectedFileId) || props.conversation.files[0];
  const preview = useMemo(() => buildPreview(props.conversation.files, { allowRemoteImages: remoteImagesAllowed }), [props.conversation.files, remoteImagesAllowed]);
  const lineCount = file?.content.split('\n').length || 0;

  useEffect(() => { setMode('edit'); setRemoteImagesAllowed(false); }, [props.conversation.id]);
  useEffect(() => {
    if (file?.lastChangedBy === 'ai' && file.previousContent !== undefined) setMode('diff');
  }, [file?.id, file?.content, file?.lastChangedBy]);

  const addFile = () => {
    const name = safeFilename(newName);
    if (!newName.trim() || name === 'snippet.txt' && newName.trim() !== 'snippet.txt') { props.onNotify('Enter a valid file name.'); return; }
    if (props.conversation.files.some((item) => item.name === name)) { props.onNotify('A file with that name already exists.'); return; }
    props.onCreateFile(name);
    setNewName(''); setCreating(false); setMode('edit');
  };

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    const taken = new Set(props.conversation.files.map((existing) => existing.name));
    for (const item of Array.from(files).slice(0, 10)) {
      if (item.size > 100_000) { props.onNotify(`${item.name} is over the 100 KB workspace limit.`); continue; }
      if (!/\.(html|css|js|jsx|ts|tsx|json|md|txt|py|svg|xml|sh|yaml|yml|sql|rs|go|java)$/i.test(item.name)) { props.onNotify(`${item.name} is not a supported code file.`); continue; }
      let name = safeFilename(item.name);
      if (taken.has(name)) {
        const dot = name.lastIndexOf('.');
        const base = dot < 0 ? name : name.slice(0, dot);
        const extension = dot < 0 ? '' : name.slice(dot);
        let version = 2;
        while (taken.has(`${base}-${version}${extension}`)) version++;
        name = `${base}-${version}${extension}`;
      }
      taken.add(name);
      props.onCreateFile(name, await item.text());
    }
    if (importRef.current) importRef.current.value = '';
    setMenuOpen(false); setMode('edit');
  };

  const copyFile = () => {
    if (!file) return;
    navigator.clipboard.writeText(file.content).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => props.onNotify('Could not copy to clipboard'));
  };

  return <aside className={`canvas ${props.mobileOpen ? 'canvas-mobile-open' : ''}`} aria-label="Code canvas">
    <div className="canvas-top">
      <div className="canvas-top-line"><div className="canvas-top-label"><span className="canvas-top-pulse" /> YOUR CREATIVE SPACE</div><button className="subtle-icon canvas-close" onClick={props.onClose} title="Close Canvas" aria-label="Close Canvas"><X size={18} /></button></div>
      <div className="canvas-title-row"><div><h2>Canvas<span>✳</span></h2><p>Where your ideas take shape.</p></div><span className="canvas-version">01 / WORKSPACE</span></div>
    </div>

    <div className="canvas-file-area">
      <div className="canvas-file-title">
        <span><FolderOpen size={15} /> FILES <span className="canvas-file-count">{String(props.conversation.files.length).padStart(2, '0')}</span></span>
        <div>
          <input ref={importRef} type="file" hidden multiple accept=".html,.css,.js,.jsx,.ts,.tsx,.json,.md,.txt,.py,.svg,.xml,.sh,.yaml,.yml,.sql,.rs,.go,.java" onChange={(event) => void importFiles(event.target.files)} />
          <button className="subtle-icon" onClick={props.onPublishGitHub} title="Review and publish Canvas files to GitHub" aria-label="Review and publish Canvas files to GitHub"><Github size={16} /></button>
          <button className="subtle-icon" onClick={() => setCreating(true)} title="New file" aria-label="New file"><Plus size={17} /></button>
          <div className="canvas-menu-anchor">
            <button className="subtle-icon" onClick={() => setMenuOpen(!menuOpen)} title="More file actions" aria-label="More file actions"><MoreHorizontal size={17} /></button>
            {menuOpen && <div className="canvas-dropdown">
              <button onClick={() => { setCreating(true); setMenuOpen(false); }}><FilePlus2 size={14} /> New file</button>
              <button onClick={() => importRef.current?.click()}><FolderOpen size={14} /> Import files</button>
              <button onClick={() => { void downloadProject(props.conversation.files).catch(() => props.onNotify('Could not export project.')); setMenuOpen(false); }} disabled={!props.conversation.files.length}><ArrowDownToLine size={14} /> Download project .zip</button>
            </div>}
          </div>
        </div>
      </div>

      {creating && <div className="canvas-create"><FilePlus2 size={15} /><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addFile(); if (event.key === 'Escape') setCreating(false); }} placeholder="filename.ext" aria-label="New file name" /><button onClick={addFile} aria-label="Create file"><Check size={15} /></button><button onClick={() => setCreating(false)} aria-label="Cancel"><X size={15} /></button></div>}

      <div className="canvas-files">{props.conversation.files.length ? props.conversation.files.map((item) => <div key={item.id} className={`canvas-file ${file?.id === item.id ? 'active' : ''}`}>
        <button onClick={() => { props.onSelectFile(item.id); setMode(item.lastChangedBy === 'ai' && item.previousContent !== undefined ? 'diff' : 'edit'); }} title={item.name}><span className={`file-type-dot file-${fileColor(item.name)}`} /><span className="canvas-file-name">{item.name}</span>{item.origin === 'generated' && <span className="file-ai-tag">AI</span>}</button>
        <button className="canvas-file-delete" onClick={() => { if (window.confirm(`Delete ${item.name} from this workspace?`)) props.onDeleteFile(item.id); }} title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`}><Trash2 size={13} /></button>
      </div>) : <div className="canvas-no-files">No files yet. Create one to get started.</div>}</div>
    </div>

    <div className="canvas-editor-tabs">
      <div className="canvas-tabs" role="tablist" aria-label="Canvas modes">
        <button type="button" role="tab" aria-selected={mode === 'view'} className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')} title="View source without editing"><Eye size={14} /> VIEW</button>
        <button type="button" role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')} title="Edit and autosave this file"><Code2 size={14} /> EDIT</button>
        <button type="button" role="tab" aria-selected={mode === 'test'} className={mode === 'test' ? 'active' : ''} onClick={() => { setMode('test'); setRefresh((value) => value + 1); }} title="Run an HTML/SVG preview in the safe sandbox"><Play size={13} /> TEST</button>
        <button type="button" role="tab" aria-selected={mode === 'diff'} className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')} title="Compare the latest edit"><FileDiff size={14} /> DIFF</button>
      </div>
      <div className="canvas-tab-actions">
        {mode === 'test'
          ? <button onClick={() => setRefresh((value) => value + 1)} title="Re-run sandbox preview" aria-label="Re-run sandbox preview"><RefreshCw size={15} /></button>
          : <><button onClick={copyFile} disabled={!file} title="Copy file" aria-label="Copy file">{copied ? <Check size={15} /> : <Copy size={15} />}</button><button onClick={() => file && downloadFile(file)} disabled={!file} title="Download file" aria-label="Download file"><ArrowDownToLine size={15} /></button></>}
      </div>
    </div>

    <div className="canvas-editor-content" role="tabpanel" aria-label={`${mode.toUpperCase()} canvas mode`}>
      {mode === 'view' || mode === 'edit' ? file
        ? <Suspense fallback={<div className="editor-loading"><FileCode2 size={20} /><span>Preparing your canvas...</span></div>}><CodeEditor key={file.id} file={file} readOnly={mode === 'view'} onChange={(value) => props.onUpdateFile(file.id, value)} /></Suspense>
        : <div className="canvas-empty"><Files size={25} /><strong>Nothing on the canvas yet.</strong><p>Create a file to start building.</p><button onClick={() => setCreating(true)}>Create a file <Plus size={14} /></button></div>
        : mode === 'test' ? preview
          ? <div className="preview-shell"><div className="preview-browser"><span className="preview-dots"><i /><i /><i /></span><span className="preview-address"><span className="preview-lock">⌁</span> isolated sandbox test</span><span>↗</span></div><iframe key={refresh} sandbox="allow-scripts" referrerPolicy="no-referrer" title="Sandboxed HTML/SVG test preview" srcDoc={preview} /></div>
          : <div className="canvas-empty"><Eye size={26} /><strong>Nothing to test yet.</strong><p>Test mode renders HTML or SVG in an isolated frame. CSS and JavaScript files are included automatically; shell and unit tests are not run here.</p><button onClick={() => { setCreating(true); setNewName('index.html'); setMode('edit'); }}>Create HTML file <Plus size={14} /></button></div>
        : file ? <CanvasDiff file={file} onRestore={() => props.onRestoreFile(file.id)} />
          : <div className="canvas-empty"><FileDiff size={26} /><strong>Nothing to compare yet.</strong><p>Create or select a file to see its changes.</p></div>}
    </div>

    <div className="canvas-bottom">
      <div className="canvas-bottom-meta">
        <span className="canvas-bottom-indicator" />
        {mode === 'test' ? 'SAFE SANDBOX TEST' : mode === 'diff' ? 'DIFF · GREEN ADDED / RED DELETED' : file ? `${mode === 'view' ? 'READ-ONLY' : fileLanguage(file.name).toUpperCase()}  ·  ${lineCount} LINES` : 'NO FILE SELECTED'}
        <span className="canvas-bottom-right">AUTOSAVED LOCALLY</span>
      </div>
      {file && mode !== 'test' && <button className="canvas-context-button" title={`Attach ${file.name} to chat so AIFLUX can edit it`} onClick={() => props.onAddContext(file)}><span><FileCode2 size={15} /> Edit {file.name.split('/').at(-1)} with AI</span><ArrowUpRight size={16} /></button>}
      {mode === 'test' && <div className="preview-test-controls">
        <button type="button" className={remoteImagesAllowed ? 'remote-images-enabled' : ''} aria-pressed={remoteImagesAllowed} onClick={() => { setRemoteImagesAllowed((allowed) => !allowed); setRefresh((value) => value + 1); }} title="Allow only HTTPS image requests; the image host may see your IP address."><Globe2 size={13} /> Remote images {remoteImagesAllowed ? 'ON' : 'OFF'}</button>
        <span>{remoteImagesAllowed ? 'HTTPS images are enabled; hosts may see your IP. External scripts, fetch, and forms remain blocked.' : 'Off by default. Enable to load HTTPS images; inline/data images work without it.'}</span>
      </div>}
    </div>
  </aside>;
}
