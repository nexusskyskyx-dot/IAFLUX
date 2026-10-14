import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, FileCode2, GitBranch, GitPullRequest, Github, LoaderCircle, LockKeyhole, ShieldCheck, Upload, X } from 'lucide-react';
import type { WorkspaceFile } from '../types';

interface Props {
  files: WorkspaceFile[];
  onClose: () => void;
  onNotify: (message: string) => void;
  onConnect: () => void;
}

interface GitHubStatus { configured: boolean; connected: boolean; login: string }
interface GitHubRepo { id: number; fullName: string; name: string; private: boolean; defaultBranch: string }
interface GitHubBranch { name: string; protected: boolean; commitSha: string }
interface ReviewItem { id: string; file: WorkspaceFile; path: string; previous: string | null }
interface PublishResult { mode: 'pull_request' | 'push'; branch: string; commitUrl: string; pullRequestUrl: string; warning: string }
type PublishMode = 'pull_request' | 'push';

class GitHubRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function getJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options?.headers || {}),
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new GitHubRequestError(typeof data.error === 'string' ? data.error : 'GitHub request failed.', response.status);
  return data as T;
}

function validRepositoryPath(path: string) {
  if (!path || path.length > 400 || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || ['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output'].includes(part.toLowerCase()))) return false;
  if (/(^|\/)(\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/i.test(path)) return false;
  return /\.(md|mdx|txt|js|jsx|ts|tsx|mjs|cjs|json|html|css|scss|sass|less|py|sh|svg|xml|ya?ml|sql|java|go|rs|c|cc|cpp|h|hpp|rb|php|vue|svelte|toml|ini|properties|graphql|gql|ipynb)$/i.test(path);
}

function validBranchName(value: string) {
  if (!value || value.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value.endsWith('/') || value.endsWith('.')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.') && !part.endsWith('.lock'));
}

function errorText(error: unknown) { return error instanceof Error ? error.message : 'GitHub request failed. Please try again.'; }

export default function GitHubPublishModal({ files, onClose, onNotify, onConnect }: Props) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [baseBranch, setBaseBranch] = useState('');
  const [mode, setMode] = useState<PublishMode>('pull_request');
  const [featureBranch, setFeatureBranch] = useState(() => `aiflux/ai-fix-${Date.now().toString(36)}`);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [step, setStep] = useState<'setup' | 'review' | 'success'>('setup');
  const [result, setResult] = useState<PublishResult | null>(null);
  const [commitMessage, setCommitMessage] = useState('Apply AI-assisted code updates');
  const [pullRequestTitle, setPullRequestTitle] = useState('AI-assisted code updates');
  const [pullRequestBody, setPullRequestBody] = useState('Proposed changes generated and reviewed in AIFLUX.');
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [directPushConfirmed, setDirectPushConfirmed] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [loadingReview, setLoadingReview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');

  const refreshRepos = useCallback(async () => {
    setLoadingRepos(true);
    setError('');
    try {
      const data = await getJson<{ repos: GitHubRepo[] }>('/api/github/repos');
      setRepos(Array.isArray(data.repos) ? data.repos : []);
    } catch (requestError) { setError(errorText(requestError)); }
    finally { setLoadingRepos(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await getJson<GitHubStatus>('/api/github?op=status');
        if (cancelled) return;
        setStatus(next);
        if (next.connected) await refreshRepos();
      } catch (requestError) { if (!cancelled) setError(errorText(requestError)); }
      finally { if (!cancelled) setLoadingStatus(false); }
    };
    void load();
    return () => { cancelled = true; };
  }, [refreshRepos]);

  useEffect(() => {
    setPaths(Object.fromEntries(files.map((file) => [file.id, file.name])));
    setIncluded(Object.fromEntries(files.map((file) => [file.id, file.origin !== 'starter'])));
    setReview([]);
    setStep('setup');
    setReviewConfirmed(false);
    setDirectPushConfirmed(false);
  }, [files]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !publishing) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, publishing]);

  const selectedFiles = useMemo(() => files.filter((file) => included[file.id]), [files, included]);
  const expectedBaseSha = branches.find((branch) => branch.name === baseBranch)?.commitSha || '';
  const pathsValid = selectedFiles.every((file) => validRepositoryPath(paths[file.id] || ''));
  const pathsUnique = new Set(selectedFiles.map((file) => paths[file.id] || '')).size === selectedFiles.length;
  const fileSizesValid = selectedFiles.every((file) => new TextEncoder().encode(file.content).length <= 30_000);
  const branchValid = mode !== 'pull_request' || (validBranchName(featureBranch) && featureBranch !== baseBranch);
  const commitMessageValid = Boolean(commitMessage.trim() && commitMessage.trim().length <= 160 && !/[\r\n\u0000]/.test(commitMessage));
  const pullRequestDetailsValid = mode !== 'pull_request' || Boolean(pullRequestTitle.trim() && pullRequestTitle.trim().length <= 256 && !/[\r\n\u0000]/.test(pullRequestTitle) && pullRequestBody.length <= 4000 && !/[\u0000]/.test(pullRequestBody));
  const canReview = Boolean(selectedRepo && baseBranch && expectedBaseSha && selectedFiles.length && pathsValid && pathsUnique && fileSizesValid && selectedFiles.length <= 20 && branchValid && commitMessageValid && pullRequestDetailsValid && !loadingReview && !loadingBranches);

  const selectRepository = async (fullName: string) => {
    const repo = repos.find((item) => item.fullName === fullName) || null;
    setSelectedRepo(repo);
    setBranches([]);
    setBaseBranch('');
    setReview([]);
    setStep('setup');
    setReviewConfirmed(false);
    setDirectPushConfirmed(false);
    setError('');
    if (!repo) return;
    setLoadingBranches(true);
    try {
      const data = await getJson<{ branches: GitHubBranch[] }>(`/api/github/branches?full_name=${encodeURIComponent(repo.fullName)}`);
      const available = Array.isArray(data.branches) ? data.branches : [];
      setBranches(available);
      const defaultBranch = available.find((branch) => branch.name === repo.defaultBranch) || available[0];
      if (defaultBranch) setBaseBranch(defaultBranch.name);
      else setError('No supported repository branch was found. Check your GitHub App permissions and refresh.');
    } catch (requestError) { setError(errorText(requestError)); }
    finally { setLoadingBranches(false); }
  };

  const updatePath = (id: string, value: string) => {
    setPaths((previous) => ({ ...previous, [id]: value }));
    setReview([]);
    setStep('setup');
    setReviewConfirmed(false);
  };

  const reviewChanges = async () => {
    if (!canReview || !selectedRepo) return;
    setLoadingReview(true);
    setError('');
    try {
      const selectedBranch = baseBranch;
      const items = await Promise.all(selectedFiles.map(async (file) => {
        const path = paths[file.id];
        const query = `full_name=${encodeURIComponent(selectedRepo.fullName)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(selectedBranch)}`;
        try {
          const current = await getJson<{ content: string }>(`/api/github/file?${query}`);
          return { id: file.id, file, path, previous: current.content };
        } catch (requestError) {
          if (requestError instanceof GitHubRequestError && requestError.status === 404) return { id: file.id, file, path, previous: null };
          throw requestError;
        }
      }));
      setReview(items);
      setStep('review');
      setReviewConfirmed(false);
      setDirectPushConfirmed(false);
    } catch (requestError) { setError(errorText(requestError)); }
    finally { setLoadingReview(false); }
  };

  const publish = async () => {
    if (!selectedRepo || !expectedBaseSha || !reviewConfirmed || publishing || (mode === 'push' && !directPushConfirmed)) return;
    if (mode === 'pull_request' && !featureBranch.trim()) return;
    setPublishing(true);
    setError('');
    try {
      const payload = {
        fullName: selectedRepo.fullName,
        mode,
        baseBranch,
        expectedBaseSha,
        branchName: featureBranch.trim(),
        targetBranch: baseBranch,
        commitMessage,
        pullRequestTitle,
        pullRequestBody,
        files: review.map((item) => ({ path: item.path, content: item.file.content })),
      };
      const published = await getJson<PublishResult>('/api/github/changes', { method: 'POST', body: JSON.stringify(payload) });
      setResult(published);
      setStep('success');
      onNotify(published.pullRequestUrl ? 'Draft pull request created on GitHub.' : published.mode === 'push' ? 'Changes pushed to GitHub.' : 'Changes pushed to a GitHub branch.');
    } catch (requestError) { setError(errorText(requestError)); }
    finally { setPublishing(false); }
  };

  return <div className="modal-backdrop github-backdrop github-publish-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !publishing) onClose(); }}>
    <section className="github-publish-modal" role="dialog" aria-modal="true" aria-labelledby="github-publish-title">
      <header className="github-publish-header">
        <div className="github-header-icon"><Github size={21} /></div>
        <div className="github-header-title"><div className="eyebrow">REVIEW BEFORE PUBLISH</div><h2 id="github-publish-title">Send Canvas changes<span>.</span></h2><p>Nothing is written to GitHub until you review and confirm.</p></div>
        {status?.connected && <span className="github-publish-account"><LockKeyhole size={12} /> {status.login}</span>}
        <button className="icon-button settings-close" onClick={onClose} aria-label="Close GitHub publisher" disabled={publishing}><X size={20} /></button>
      </header>

      {loadingStatus ? <div className="github-loading"><LoaderCircle size={19} className="spin" /> Checking GitHub connection…</div> : !status?.configured ? <div className="github-unconfigured">
        <span className="github-state-icon"><LockKeyhole size={24} /></span>
        <h3>GitHub publishing is not configured</h3>
        <p>A workspace administrator needs to enable Contents read/write access, and Pull requests read/write access for the reviewed-PR option.</p>
      </div> : !status.connected ? <div className="github-connect-state">
        <span className="github-state-icon"><Github size={26} /></span>
        <h3>Connect GitHub to publish</h3>
        <p>Sign in with your own GitHub account. You’ll only be able to publish to repositories the GitHub App is installed on and your account can access.</p>
        <button className="primary-button github-connect-button" onClick={onConnect}><Github size={16} /> Connect GitHub</button>
      </div> : step === 'success' && result ? <div className="github-publish-success">
        <span className="github-state-icon"><Check size={25} /></span>
        <h3>{result.pullRequestUrl ? 'Draft pull request created' : result.mode === 'push' ? 'Changes pushed' : 'Changes pushed to a branch'}</h3>
        <p>{selectedRepo?.fullName} · <code>{result.branch}</code></p>
        {result.warning && <div className="github-error" role="alert">{result.warning}</div>}
        <div className="github-publish-result-links">
          {result.pullRequestUrl && <a href={result.pullRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest size={15} /> Open draft pull request <ArrowUpRight size={14} /></a>}
          {result.commitUrl && <a href={result.commitUrl} target="_blank" rel="noreferrer"><GitBranch size={15} /> View commit <ArrowUpRight size={14} /></a>}
        </div>
        <button className="secondary-button" onClick={onClose}>Done</button>
      </div> : !repos.length && !loadingRepos ? <div className="github-connect-state">
        <span className="github-state-icon"><FolderIcon /></span>
        <h3>No installed repositories found</h3>
        <p>Install the AIFLUX GitHub App on a repository, grant the required permissions, then refresh.</p>
        {error && <div className="github-error" role="alert">{error}</div>}
        <button className="secondary-button" onClick={() => void refreshRepos()}><LoaderCircle size={14} /> Refresh repositories</button>
      </div> : step === 'review' ? <>
        <div className="github-publish-review-summary"><ShieldCheck size={16} /> Review the exact Canvas content below. The server also checks that the selected branch has not moved since this review.</div>
        <div className="github-publish-review-list">
          {review.map((item) => <details key={item.id} className="github-publish-review-file" open>
            <summary><FileCode2 size={14} /><strong>{item.path}</strong><span>{item.previous === null ? 'NEW FILE' : item.previous === item.file.content ? 'UNCHANGED' : 'REPLACE'}</span></summary>
            <div className="github-publish-review-columns">
              <section><h4>{item.previous === null ? 'Current: file does not exist' : `Current on ${baseBranch}`}</h4><pre>{item.previous ?? '(New file)'}</pre></section>
              <section><h4>Proposed Canvas content</h4><pre>{item.file.content}</pre></section>
            </div>
          </details>)}
        </div>
        <div className="github-publish-footer">
          {error && <div className="github-error" role="alert">{error}</div>}
          <div className="github-publish-target"><strong>{mode === 'pull_request' ? 'Draft PR' : 'Direct push'}:</strong> {selectedRepo?.fullName} · <code>{mode === 'pull_request' ? `${featureBranch} → ${baseBranch}` : baseBranch}</code></div>
          <label className="github-publish-confirm"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} /> I reviewed the listed files and authorize this GitHub write.</label>
          {mode === 'push' && <label className="github-publish-confirm github-publish-danger"><input type="checkbox" checked={directPushConfirmed} onChange={(event) => setDirectPushConfirmed(event.target.checked)} /> I understand this pushes directly to <code>{baseBranch}</code> without a pull request.</label>}
          <div className="github-publish-actions"><button className="secondary-button" onClick={() => { setStep('setup'); setReviewConfirmed(false); setDirectPushConfirmed(false); }} disabled={publishing}>Back</button><button className="primary-button" onClick={() => void publish()} disabled={!reviewConfirmed || (mode === 'push' && !directPushConfirmed) || publishing}>{publishing ? <LoaderCircle size={15} className="spin" /> : mode === 'pull_request' ? <GitPullRequest size={15} /> : <Upload size={15} />}{publishing ? ' Publishing…' : mode === 'pull_request' ? ' Create draft PR' : ` Push to ${baseBranch}`}</button></div>
        </div>
      </> : <div className="github-publish-setup">
        <div className="github-publish-form-row"><label>Repository<select value={selectedRepo?.fullName || ''} onChange={(event) => void selectRepository(event.target.value)}><option value="">Choose an installed repository…</option>{repos.map((repo) => <option key={repo.id} value={repo.fullName}>{repo.fullName}{repo.private ? ' · Private' : ''}</option>)}</select></label><button className="subtle-icon" onClick={() => void refreshRepos()} title="Refresh repository list" aria-label="Refresh repository list" disabled={loadingRepos}>{loadingRepos ? <LoaderCircle size={15} className="spin" /> : <Github size={15} />}</button></div>
        {selectedRepo && <>
          <div className="github-publish-form-row"><label>Base / target branch<select value={baseBranch} onChange={(event) => { setBaseBranch(event.target.value); setReview([]); setReviewConfirmed(false); }} disabled={loadingBranches}><option value="">{loadingBranches ? 'Loading branches…' : 'Choose a branch…'}</option>{branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}{branch.protected ? ' · protected' : ''}</option>)}</select></label>{mode === 'pull_request' && <label>New branch<input value={featureBranch} onChange={(event) => setFeatureBranch(event.target.value)} maxLength={180} placeholder="aiflux/ai-fix" /></label>}</div>
          <div className="github-publish-modes"><label className={mode === 'pull_request' ? 'active' : ''}><input type="radio" name="github-publish-mode" checked={mode === 'pull_request'} onChange={() => { setMode('pull_request'); setDirectPushConfirmed(false); }} /><span><strong>Create a draft pull request</strong><small>Recommended · writes to a new branch for review</small></span></label><label className={mode === 'push' ? 'active danger' : ''}><input type="radio" name="github-publish-mode" checked={mode === 'push'} onChange={() => { setMode('push'); setDirectPushConfirmed(false); }} /><span><strong>Push directly to branch</strong><small>Higher risk · repository branch rules still apply</small></span></label></div>
          {mode === 'pull_request' && <div className="github-publish-form-row"><label>Commit message<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} maxLength={160} /></label><label>Pull request title<input value={pullRequestTitle} onChange={(event) => setPullRequestTitle(event.target.value)} maxLength={256} /></label></div>}
          {mode === 'pull_request' && <label className="github-publish-body-label">Pull request description<textarea value={pullRequestBody} onChange={(event) => setPullRequestBody(event.target.value)} maxLength={4000} rows={2} /></label>}
          {mode === 'push' && <label className="github-publish-body-label">Commit message<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} maxLength={160} /></label>}
          <div className="github-publish-files-heading"><span>FILES TO PUBLISH</span><small>{selectedFiles.length} selected · up to 20 files / 30 KB each</small></div>
          <div className="github-publish-files">
            {files.map((file) => <div key={file.id} className="github-publish-file-row"><label className="github-publish-file-check"><input type="checkbox" checked={Boolean(included[file.id])} onChange={(event) => { setIncluded((previous) => ({ ...previous, [file.id]: event.target.checked })); setReview([]); setReviewConfirmed(false); }} /><FileCode2 size={14} /><span>{file.name}</span><small>{file.origin === 'generated' ? 'AI' : file.origin === 'starter' ? 'starter' : 'edited'}</small></label><input aria-label={`GitHub path for ${file.name}`} value={paths[file.id] || ''} onChange={(event) => updatePath(file.id, event.target.value)} placeholder="repository/path.ext" /></div>)}
            {!files.length && <div className="github-list-state">Canvas has no files to publish.</div>}
          </div>
        </>}
        {error && <div className="github-error" role="alert">{error}</div>}
        {selectedFiles.some((file) => !validRepositoryPath(paths[file.id] || '')) && <div className="github-publish-warning"><CircleAlert size={14} /> Use a supported text/code path. Secret files such as .env and private keys are blocked.</div>}
        {!pathsUnique && <div className="github-publish-warning"><CircleAlert size={14} /> Each selected file must have a unique repository path.</div>}
        {!fileSizesValid && <div className="github-publish-warning"><CircleAlert size={14} /> Each file must be 30 KB or smaller.</div>}
        {selectedFiles.length > 20 && <div className="github-publish-warning"><CircleAlert size={14} /> Select no more than 20 files per publish.</div>}
        {files.length > 0 && selectedFiles.length === 0 && <div className="github-publish-warning"><CircleAlert size={14} /> Select at least one Canvas file to publish.</div>}
        {!branchValid && <div className="github-publish-warning"><CircleAlert size={14} /> Enter a valid, different branch name for the draft PR.</div>}
        {!commitMessageValid && <div className="github-publish-warning"><CircleAlert size={14} /> Enter a one-line commit message of 1–160 characters.</div>}
        {!pullRequestDetailsValid && <div className="github-publish-warning"><CircleAlert size={14} /> Check the pull request title and description limits.</div>}
        <div className="github-publish-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => void reviewChanges()} disabled={!canReview}>{loadingReview ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}{loadingReview ? ' Loading review…' : ' Review changes'}</button></div>
      </div>}
    </section>
  </div>;
}

function FolderIcon() { return <FileCode2 size={24} />; }
