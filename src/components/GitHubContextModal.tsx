import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Check, CircleDot, FileCode2, FolderGit2, Github, GitPullRequest, LoaderCircle, LogOut, LockKeyhole, Search, ShieldCheck, X } from 'lucide-react';
import type { AttachedFile } from '../types';

interface Props {
  onClose: () => void;
  onUseContext: (file: AttachedFile) => void;
  onNotify: (message: string) => void;
}

interface GitHubStatus {
  configured: boolean;
  connected: boolean;
  login: string;
  installUrl?: string;
}

interface GitHubRepo {
  id: number;
  fullName: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  updatedAt: string;
}

interface RepoFile { path: string; size: number }
interface GitHubItem { number: number; title: string; state: string; updatedAt: string; url: string; author: string; body: string }
interface RepoContent {
  repo: { fullName: string; description: string; private: boolean; defaultBranch: string; url: string };
  files: RepoFile[];
  filesTruncated: boolean;
  issues: GitHubItem[];
  pullRequests: GitHubItem[];
}

async function getJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options?.headers || {}), ...(options?.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'GitHub request failed.');
  return data as T;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'GitHub request failed. Please try again.'; }

export default function GitHubContextModal({ onClose, onUseContext, onNotify }: Props) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoSearch, setRepoSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [repoContent, setRepoContent] = useState<RepoContent | null>(null);
  const [tab, setTab] = useState<'files' | 'issues' | 'pulls'>('files');
  const [selectedItem, setSelectedItem] = useState<{ kind: 'file' | 'issue' | 'pull'; path?: string; item?: GitHubItem; content?: string } | null>(null);
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [loadingItem, setLoadingItem] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [error, setError] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);

  const loadRepos = useCallback(async () => {
    setLoadingRepos(true);
    setError('');
    try {
      const result = await getJson<{ repos: GitHubRepo[] }>('/api/github/repos');
      setRepos(Array.isArray(result.repos) ? result.repos : []);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setLoadingRepos(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await getJson<GitHubStatus>('/api/github?op=status');
        if (cancelled) return;
        setStatus(next);
        if (next.connected) await loadRepos();
      } catch (requestError) {
        if (!cancelled) setError(errorMessage(requestError));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [loadRepos]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filteredRepos = useMemo(() => {
    const query = repoSearch.trim().toLowerCase();
    return query ? repos.filter((repo) => `${repo.fullName} ${repo.description}`.toLowerCase().includes(query)) : repos;
  }, [repoSearch, repos]);

  const selectRepo = async (repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setRepoContent(null);
    setSelectedItem(null);
    setError('');
    setLoadingRepo(true);
    try {
      const result = await getJson<RepoContent>(`/api/github/repo?full_name=${encodeURIComponent(repo.fullName)}`);
      setRepoContent(result);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setLoadingRepo(false); }
  };

  const selectFile = async (file: RepoFile) => {
    if (!selectedRepo) return;
    setError('');
    setLoadingItem(true);
    setSelectedItem({ kind: 'file', path: file.path });
    try {
      const result = await getJson<{ path: string; content: string }>(`/api/github/file?full_name=${encodeURIComponent(selectedRepo.fullName)}&path=${encodeURIComponent(file.path)}&ref=${encodeURIComponent(selectedRepo.defaultBranch)}`);
      setSelectedItem({ kind: 'file', path: file.path, content: result.content });
    } catch (requestError) { setError(errorMessage(requestError)); setSelectedItem(null); }
    finally { setLoadingItem(false); }
  };

  const selectItem = async (kind: 'issue' | 'pull', item: GitHubItem) => {
    if (!selectedRepo) return;
    setError('');
    setLoadingItem(true);
    setSelectedItem({ kind, item });
    try {
      const operation = kind === 'issue' ? 'issue' : 'pull';
      const result = await getJson<Record<string, GitHubItem>>(`/api/github/${operation}?full_name=${encodeURIComponent(selectedRepo.fullName)}&number=${item.number}`);
      setSelectedItem({ kind, item: result.issue || result.pullRequest || item });
    } catch (requestError) { setError(errorMessage(requestError)); setSelectedItem(null); }
    finally { setLoadingItem(false); }
  };

  const addSelectedContext = () => {
    if (!selectedRepo || !selectedItem) return;
    if (selectedItem.kind === 'file' && selectedItem.path && typeof selectedItem.content === 'string') {
      onUseContext({ name: `${selectedRepo.fullName}/${selectedItem.path}`, content: selectedItem.content });
      return;
    }
    if ((selectedItem.kind === 'issue' || selectedItem.kind === 'pull') && selectedItem.item) {
      const item = selectedItem.item;
      const kind = selectedItem.kind === 'issue' ? 'Issue' : 'Pull request';
      const content = `# ${kind} #${item.number}: ${item.title}\nRepository: ${selectedRepo.fullName}\nState: ${item.state}\nAuthor: ${item.author || 'unknown'}\nURL: ${item.url}\n\n${item.body || '(No description provided.)'}`;
      onUseContext({ name: `${selectedRepo.fullName}/${kind.toLowerCase()}-${item.number}.md`, content });
      return;
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await getJson('/api/github?op=disconnect', { method: 'POST' });
      setStatus((previous) => previous ? { ...previous, connected: false, login: '' } : previous);
      setRepos([]);
      setSelectedRepo(null);
      setRepoContent(null);
      onNotify('GitHub disconnected.');
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setDisconnecting(false); }
  };

  return <div className="modal-backdrop github-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="github-modal" role="dialog" aria-modal="true" aria-labelledby="github-title">
      <header className="github-header">
        <div className="github-header-icon"><Github size={21} /></div>
        <div className="github-header-title"><div className="eyebrow">GITHUB CONTEXT & APPROVED PUBLISHING</div><h2 id="github-title">Connect your code<span>.</span></h2><p>Browse repository context here; review and confirm Canvas changes before publishing.</p></div>
        {status?.connected && <span className="github-readonly-badge"><ShieldCheck size={12} /> USER-APPROVED WRITES</span>}
        <button className="icon-button settings-close" onClick={onClose} aria-label="Close GitHub browser"><X size={20} /></button>
      </header>

      {!status ? <div className="github-loading"><LoaderCircle size={19} className="spin" /> Checking GitHub connection…</div> : !status.configured ? <div className="github-unconfigured">
        <span className="github-state-icon"><LockKeyhole size={24} /></span>
        <h3>GitHub OAuth is not configured</h3>
        <p>A workspace administrator needs to create a GitHub App with Contents read/write, Pull requests read/write, and Issues read-only permissions, then add its OAuth credentials to the server environment.</p>
        <button className="secondary-button" onClick={onClose}>Close</button>
      </div> : !status.connected ? <div className="github-connect-state">
        <span className="github-state-icon"><Github size={26} /></span>
        <h3>Bring a repository into the conversation</h3>
        <p>Sign in with GitHub and install the AIFLUX GitHub App on repositories you can access. AIFLUX only publishes Canvas changes after you review the exact files and explicitly confirm.</p>
        {error && <div className="github-error" role="alert">{error}</div>}
        <a className="primary-button github-connect-button" href="/api/github?op=connect"><Github size={16} /> Continue with GitHub <ArrowUpRight size={15} /></a>
        <small>Access stays on the server in an encrypted, HttpOnly session cookie. No token is pasted into chat.</small>
      </div> : <div className="github-browser">
        <aside className="github-repo-sidebar">
          <div className="github-account-row"><span className="github-account-avatar">{status.login.slice(0, 1).toUpperCase()}</span><span><strong>{status.login}</strong><small>Connected account</small></span><button title="Disconnect GitHub" aria-label="Disconnect GitHub" className="github-disconnect" onClick={() => void disconnect()} disabled={disconnecting}>{disconnecting ? <LoaderCircle size={15} className="spin" /> : <LogOut size={15} />}</button></div>
          <label className="github-repo-search"><Search size={14} /><input value={repoSearch} onChange={(event) => setRepoSearch(event.target.value)} placeholder="Find a repository" aria-label="Find a repository" /></label>
          <div className="github-repo-label">YOUR INSTALLED REPOSITORIES <span>{repos.length}</span></div>
          <div className="github-repo-list">
            {loadingRepos ? <div className="github-list-state"><LoaderCircle size={16} className="spin" /> Loading repositories…</div> : filteredRepos.length ? filteredRepos.map((repo) => <button key={`${repo.id}-${repo.fullName}`} className={`github-repo-option ${selectedRepo?.id === repo.id ? 'active' : ''}`} onClick={() => void selectRepo(repo)}><FolderGit2 size={15} /><span><strong>{repo.name}</strong><small>{repo.fullName}{repo.private ? ' · Private' : ''}</small></span></button>) : repos.length ? <div className="github-list-state">No repositories match that search.</div> : <div className="github-list-state">No repositories installed yet. {status.installUrl && <a href={status.installUrl} target="_blank" rel="noreferrer">Install the GitHub App</a>} Then refresh.</div>}
          </div>
          <button className="github-refresh" onClick={() => void loadRepos()} disabled={loadingRepos}><LoaderCircle size={14} className={loadingRepos ? 'spin' : ''} /> Refresh repositories</button>
        </aside>

        <main className="github-main">
          {error && <div className="github-error github-error-inline" role="alert">{error}</div>}
          {!selectedRepo ? <div className="github-empty-state"><span className="github-state-icon"><FolderGit2 size={24} /></span><h3>Choose a repository</h3><p>Only repositories the installed GitHub App can access will appear here.</p></div> : <>
            <div className="github-repo-heading"><div><div className="github-repo-eyebrow">{selectedRepo.private ? <><LockKeyhole size={12} /> PRIVATE</> : 'PUBLIC'} <span>·</span> {selectedRepo.defaultBranch}</div><h3>{selectedRepo.fullName}</h3><p>{repoContent?.repo.description || selectedRepo.description || 'No repository description.'}</p></div><a href={selectedRepo.url} target="_blank" rel="noreferrer" title="Open repository on GitHub"><ArrowUpRight size={16} /></a></div>
            <div className="github-tabs" role="tablist" aria-label="Repository content">
              <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => { setTab('files'); setSelectedItem(null); }}><FileCode2 size={15} /> Files <span>{repoContent?.files.length ?? '—'}</span></button>
              <button role="tab" aria-selected={tab === 'issues'} className={tab === 'issues' ? 'active' : ''} onClick={() => { setTab('issues'); setSelectedItem(null); }}><CircleDot size={15} /> Issues <span>{repoContent?.issues.length ?? '—'}</span></button>
              <button role="tab" aria-selected={tab === 'pulls'} className={tab === 'pulls' ? 'active' : ''} onClick={() => { setTab('pulls'); setSelectedItem(null); }}><GitPullRequest size={15} /> Pull requests <span>{repoContent?.pullRequests.length ?? '—'}</span></button>
            </div>
            {!repoContent || loadingRepo ? <div className="github-loading"><LoaderCircle size={18} className="spin" /> Loading repository context…</div> : <div className={`github-content-grid ${selectedItem ? 'has-selection' : ''}`}>
              <div className="github-items-list">
                {tab === 'files' && <>
                  {repoContent.filesTruncated && <div className="github-truncated-note">Showing a limited source-file list. Search and deep navigation are not available yet.</div>}
                  {repoContent.files.length ? repoContent.files.map((file) => <button key={file.path} className={`github-file-option ${selectedItem?.kind === 'file' && selectedItem.path === file.path ? 'active' : ''}`} onClick={() => void selectFile(file)}><FileCode2 size={14} /><span>{file.path}</span><small>{file.size ? `${Math.ceil(file.size / 1024)} KB` : ''}</small></button>) : <div className="github-list-state">No supported source files were found on the default branch.</div>}
                </>}
                {tab === 'issues' && (repoContent.issues.length ? repoContent.issues.map((item) => <button key={item.number} className={`github-item-option ${selectedItem?.kind === 'issue' && selectedItem.item?.number === item.number ? 'active' : ''}`} onClick={() => void selectItem('issue', item)}><CircleDot size={14} /><span><strong>{item.title}</strong><small>#{item.number} · {item.author} · {item.state}</small></span></button>) : <div className="github-list-state">No open issues found.</div>)}
                {tab === 'pulls' && (repoContent.pullRequests.length ? repoContent.pullRequests.map((item) => <button key={item.number} className={`github-item-option ${selectedItem?.kind === 'pull' && selectedItem.item?.number === item.number ? 'active' : ''}`} onClick={() => void selectItem('pull', item)}><GitPullRequest size={14} /><span><strong>{item.title}</strong><small>#{item.number} · {item.author} · {item.state}</small></span></button>) : <div className="github-list-state">No open pull requests found.</div>)}
              </div>
              <div className="github-preview">
                {!selectedItem ? <div className="github-preview-empty"><span><FileCode2 size={18} /></span><p>Select a {tab === 'files' ? 'file' : tab === 'issues' ? 'GitHub issue' : 'pull request'} to preview it.</p></div> : selectedItem.kind === 'file' ? <>
                  <div className="github-preview-title"><FileCode2 size={14} /><span>{selectedItem.path}</span></div>
                  {loadingItem && !selectedItem.content ? <div className="github-loading"><LoaderCircle size={17} className="spin" /> Loading file…</div> : <pre className="github-file-preview">{selectedItem.content}</pre>}
                </> : selectedItem.item ? <>
                  <div className="github-preview-title">{selectedItem.kind === 'issue' ? <CircleDot size={14} /> : <GitPullRequest size={14} />}<span>{selectedItem.item.title}</span><a href={selectedItem.item.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub"><ArrowUpRight size={14} /></a></div>
                  <div className="github-item-meta">#{selectedItem.item.number} · {selectedItem.item.state} · {selectedItem.item.author}</div>
                  {loadingItem ? <div className="github-loading"><LoaderCircle size={17} className="spin" /> Loading details…</div> : <div className="github-item-body">{selectedItem.item.body || 'No description provided.'}</div>}
                </> : null}
                {selectedItem && !loadingItem && (selectedItem.kind === 'issue' || selectedItem.kind === 'pull' ? Boolean(selectedItem.item) : typeof selectedItem.content === 'string') && <button className="github-use-context" onClick={addSelectedContext}><Check size={14} /> Add to next message</button>}
              </div>
            </div>}
          </>}
        </main>
      </div>}
    </section>
  </div>;
}
