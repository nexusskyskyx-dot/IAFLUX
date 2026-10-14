import express from 'express';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'aiflux_github_session';
const STATE_COOKIE = 'aiflux_github_state';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const STATE_MAX_AGE = 10 * 60;
const MAX_FILE_BYTES = 30_000;
const MAX_REPO_FILES = 200;
const API_VERSION = '2022-11-28';
const SAFE_TEXT_EXTENSIONS = /\.(md|mdx|txt|js|jsx|ts|tsx|mjs|cjs|json|html|css|scss|sass|less|py|sh|svg|xml|ya?ml|sql|java|go|rs|c|cc|cpp|h|hpp|rb|php|vue|svelte|toml|ini|properties|graphql|gql|ipynb)$/i;
const EXCLUDED_PATH_PARTS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output']);
const SENSITIVE_FILE = /(^|\/)(\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/i;

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function configFrom(env) {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() || '';
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim() || '';
  const sessionSecret = env.GITHUB_SESSION_SECRET || '';
  const callbackUrl = env.GITHUB_OAUTH_CALLBACK_URL?.trim() || '';
  const requestedInstallUrl = env.GITHUB_APP_INSTALL_URL?.trim() || '';
  let installUrl = '';
  try {
    const url = new URL(requestedInstallUrl);
    if (url.protocol === 'https:' && url.hostname === 'github.com' && /^\/apps\/[A-Za-z0-9-]+\/installations\/new\/?$/.test(url.pathname)) installUrl = url.toString();
  } catch { /* The install shortcut is optional. */ }
  let validCallback = '';
  if (callbackUrl) {
    try {
      const url = new URL(callbackUrl);
      if (url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') validCallback = url.toString();
    } catch { /* An invalid callback URL leaves this integration disabled. */ }
  }
  return {
    clientId,
    clientSecret,
    sessionSecret,
    callbackUrl: validCallback,
    installUrl,
    configured: Boolean(clientId && clientSecret && sessionSecret.length >= 32 && validCallback),
  };
}

function isSecureRequest(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https' || req.secure === true;
}

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(item.slice(separator + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

function setCookie(res, req, name, value, maxAge, httpOnly = true) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/api/github', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (httpOnly) parts.push('HttpOnly');
  if (isSecureRequest(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, req, name, httpOnly = true) {
  setCookie(res, req, name, '', 0, httpOnly);
}

function sessionKey(secret) {
  return createHash('sha256').update(secret).digest();
}

function sealSession(session, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function openSession(value, secret, now = Date.now()) {
  if (!value || !secret) return null;
  try {
    const [encodedIv, encodedTag, encodedCiphertext, ...rest] = value.split('.');
    if (!encodedIv || !encodedTag || !encodedCiphertext || rest.length) return null;
    const iv = Buffer.from(encodedIv, 'base64url');
    const tag = Buffer.from(encodedTag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString('utf8');
    const session = JSON.parse(plaintext);
    if (typeof session.token !== 'string' || typeof session.login !== 'string' ||
        !Number.isFinite(session.issuedAt) || now - session.issuedAt > SESSION_MAX_AGE * 1000 ||
        session.issuedAt > now + 60_000 ||
        (session.expiresAt && !Number.isFinite(session.expiresAt))) return null;
    return session;
  } catch { return null; }
}

function sameSecret(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function getCallbackUrl(req, config) {
  if (config.callbackUrl) return config.callbackUrl;
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('host');
  if (!host) throw new GitHubError(500, 'GitHub OAuth callback URL is not configured.');
  return `${protocol}://${host}/api/github`;
}

async function readJson(response) {
  try { return await response.json(); }
  catch { return {}; }
}

async function githubFetch(path, token, fetchImpl) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new GitHubError(400, 'Invalid GitHub API request.');
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'AIFLUX',
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new GitHubError(502, 'Could not reach GitHub. Try again in a moment.');
  }
  const data = await readJson(response);
  if (!response.ok) {
    if (response.status === 401) throw new GitHubError(401, 'Your GitHub connection expired. Please reconnect it.');
    if (response.status === 403) throw new GitHubError(403, 'GitHub denied this request. Confirm the app is installed with the required read permissions.');
    if (response.status === 404) throw new GitHubError(404, 'That GitHub resource is not available to this app installation.');
    if (response.status === 429) throw new GitHubError(429, 'GitHub is rate-limiting this connection. Please wait and try again.');
    throw new GitHubError(502, 'GitHub could not complete this request.');
  }
  return data;
}

async function exchangeCode(code, config, callbackUrl, codeVerifier, fetchImpl) {
  let response;
  try {
    response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'AIFLUX' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callbackUrl, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new GitHubError(502, 'Could not complete GitHub sign-in. Try again.');
  }
  const data = await readJson(response);
  if (!response.ok || typeof data.access_token !== 'string') throw new GitHubError(401, 'GitHub sign-in failed. Please reconnect and try again.');
  const expiresIn = Number(data.expires_in);
  return {
    token: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
  };
}

async function refreshSession(session, config, req, res, fetchImpl) {
  if (!session.expiresAt || session.expiresAt - Date.now() > 2 * 60_000) return session;
  if (!session.refreshToken || !config.clientId || !config.clientSecret) throw new GitHubError(401, 'Your GitHub connection expired. Please reconnect it.');
  let response;
  try {
    response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'AIFLUX' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch { throw new GitHubError(502, 'Could not refresh your GitHub connection. Try again.'); }
  const data = await readJson(response);
  if (!response.ok || typeof data.access_token !== 'string') throw new GitHubError(401, 'Your GitHub connection expired. Please reconnect it.');
  const expiresIn = Number(data.expires_in);
  const next = {
    ...session,
    token: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : session.refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
  };
  const remaining = Math.max(60, Math.min(SESSION_MAX_AGE, Math.floor((session.issuedAt + SESSION_MAX_AGE * 1000 - Date.now()) / 1000)));
  setCookie(res, req, SESSION_COOKIE, sealSession(next, config.sessionSecret), remaining);
  return next;
}

function requireSession(config, fetchImpl) {
  return async (req, res) => {
    const session = openSession(cookieValue(req, SESSION_COOKIE), config.sessionSecret);
    if (!session) throw new GitHubError(401, 'Connect your GitHub account to browse repositories.');
    return refreshSession(session, config, req, res, fetchImpl);
  };
}

function sourcePathAllowed(path) {
  if (typeof path !== 'string' || path.length > 400 || path.startsWith('/') || path.includes('\\')) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || EXCLUDED_PATH_PARTS.has(part.toLowerCase()))) return false;
  if (SENSITIVE_FILE.test(path)) return false;
  return SAFE_TEXT_EXTENSIONS.test(path);
}

function repositoryName(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || part === '.' || part === '..')) return null;
  return parts.map((part) => encodeURIComponent(part));
}

function serializeIssue(issue) {
  return {
    number: issue.number,
    title: String(issue.title || '').slice(0, 300),
    state: issue.state,
    updatedAt: issue.updated_at,
    url: issue.html_url,
    author: issue.user?.login || '',
    body: String(issue.body || '').slice(0, 12_000),
  };
}

function setSessionCookie(res, req, session, secret) {
  const sessionCookieAge = Math.max(60, Math.floor((session.issuedAt + SESSION_MAX_AGE * 1000 - Date.now()) / 1000));
  setCookie(res, req, SESSION_COOKIE, sealSession(session, secret), sessionCookieAge);
}

export function createGitHubRouter({ env = process.env, fetchImpl = fetch } = {}) {
  const router = express.Router();
  const config = configFrom(env);
  const requireGitHubSession = requireSession(config, fetchImpl);

  const handle = (callback) => (req, res) => Promise.resolve(callback(req, res)).catch((error) => {
    if (error instanceof GitHubError) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: 'GitHub integration failed. Please try again.' });
  });

  router.get('/', handle(async (req, res) => {
    const operation = req.query.op;
    if (operation === 'status') {
      let session = config.configured ? openSession(cookieValue(req, SESSION_COOKIE), config.sessionSecret) : null;
      if (session) {
        try { session = await refreshSession(session, config, req, res, fetchImpl); }
        catch { clearCookie(res, req, SESSION_COOKIE); session = null; }
      }
      return res.json({ configured: config.configured, connected: Boolean(session), login: session?.login || '', ...(config.installUrl ? { installUrl: config.installUrl } : {}) });
    }
    if (operation === 'connect') {
      if (!config.configured) throw new GitHubError(503, 'GitHub integration is not configured on this server.');
      const state = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      setCookie(res, req, STATE_COOKIE, `${state}.${codeVerifier}`, STATE_MAX_AGE);
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', getCallbackUrl(req, config));
      url.searchParams.set('state', state);
      url.searchParams.set('scope', 'offline_access');
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return res.redirect(302, url.toString());
    }
    if (req.query.code && req.query.state) {
      if (!config.configured) throw new GitHubError(503, 'GitHub integration is not configured on this server.');
      const [cookieState, codeVerifier, ...extra] = cookieValue(req, STATE_COOKIE).split('.');
      clearCookie(res, req, STATE_COOKIE);
      if (!sameSecret(String(req.query.state), cookieState) || !/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier || '') || extra.length) {
        throw new GitHubError(400, 'GitHub sign-in could not be verified. Please start again.');
      }
      if (typeof req.query.code !== 'string' || req.query.code.length > 1000) throw new GitHubError(400, 'GitHub sign-in returned an invalid code.');
      const callbackUrl = getCallbackUrl(req, config);
      const token = await exchangeCode(req.query.code, config, callbackUrl, codeVerifier, fetchImpl);
      const user = await githubFetch('/user', token.token, fetchImpl);
      if (typeof user.login !== 'string' || !user.login) throw new GitHubError(502, 'GitHub did not return an account name.');
      const session = { ...token, login: user.login, issuedAt: Date.now() };
      setSessionCookie(res, req, session, config.sessionSecret);
      const redirect = new URL('/', callbackUrl);
      redirect.searchParams.set('github', 'connected');
      return res.redirect(302, redirect.toString());
    }
    if (req.query.error) {
      clearCookie(res, req, STATE_COOKIE);
      const redirect = new URL('/', getCallbackUrl(req, config));
      redirect.searchParams.set('github', 'cancelled');
      return res.redirect(302, redirect.toString());
    }
    return res.status(400).json({ error: 'Unknown GitHub operation.' });
  }));

  router.post('/', handle(async (req, res) => {
    if (req.query.op !== 'disconnect') return res.status(400).json({ error: 'Unknown GitHub operation.' });
    clearCookie(res, req, SESSION_COOKIE);
    clearCookie(res, req, STATE_COOKIE);
    return res.json({ ok: true });
  }));

  router.get('/repos', handle(async (req, res) => {
    const session = await requireGitHubSession(req, res);
    const installationResult = await githubFetch('/user/installations?per_page=100', session.token, fetchImpl);
    const installations = Array.isArray(installationResult.installations) ? installationResult.installations.slice(0, 100) : [];
    const repos = [];
    for (const installation of installations) {
      if (!Number.isSafeInteger(installation.id)) continue;
      const result = await githubFetch(`/user/installations/${installation.id}/repositories?per_page=100`, session.token, fetchImpl);
      for (const repo of Array.isArray(result.repositories) ? result.repositories : []) {
        if (!repo.full_name || repos.some((existing) => existing.fullName === repo.full_name)) continue;
        repos.push({
          id: repo.id,
          fullName: String(repo.full_name),
          name: String(repo.name || repo.full_name),
          description: String(repo.description || '').slice(0, 500),
          private: Boolean(repo.private),
          defaultBranch: String(repo.default_branch || 'main'),
          url: String(repo.html_url || ''),
          updatedAt: repo.updated_at || '',
          installationId: installation.id,
          account: installation.account?.login || '',
        });
        if (repos.length >= 250) break;
      }
      if (repos.length >= 250) break;
    }
    repos.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return res.json({ repos });
  }));

  router.get('/repo', handle(async (req, res) => {
    const session = await requireGitHubSession(req, res);
    const [owner, repo] = repositoryName(req.query.full_name) || [];
    if (!owner || !repo) throw new GitHubError(400, 'Choose a valid repository.');
    const repository = await githubFetch(`/repos/${owner}/${repo}`, session.token, fetchImpl);
    let tree = { tree: [], truncated: false };
    try {
      const branch = await githubFetch(`/repos/${owner}/${repo}/branches/${encodeURIComponent(repository.default_branch || 'main')}`, session.token, fetchImpl);
      const treeSha = branch.commit?.commit?.tree?.sha;
      if (typeof treeSha === 'string') tree = await githubFetch(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, session.token, fetchImpl);
    } catch { /* Issues and pull requests remain usable if file listing is unavailable. */ }
    const files = (Array.isArray(tree.tree) ? tree.tree : [])
      .filter((item) => item.type === 'blob' && sourcePathAllowed(item.path))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, MAX_REPO_FILES)
      .map((item) => ({ path: item.path, size: Number(item.size) || 0 }));
    const [issues, pullRequests] = await Promise.all([
      githubFetch(`/repos/${owner}/${repo}/issues?state=open&sort=updated&direction=desc&per_page=30`, session.token, fetchImpl),
      githubFetch(`/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`, session.token, fetchImpl),
    ]);
    return res.json({
      repo: {
        fullName: String(repository.full_name || `${owner}/${repo}`),
        description: String(repository.description || '').slice(0, 1000),
        private: Boolean(repository.private),
        defaultBranch: String(repository.default_branch || 'main'),
        url: String(repository.html_url || ''),
      },
      files,
      filesTruncated: Boolean(tree.truncated) || (Array.isArray(tree.tree) && files.length >= MAX_REPO_FILES),
      issues: (Array.isArray(issues) ? issues : []).filter((issue) => !issue.pull_request).slice(0, 30).map(serializeIssue),
      pullRequests: (Array.isArray(pullRequests) ? pullRequests : []).slice(0, 30).map(serializeIssue),
    });
  }));

  router.get('/issue', handle(async (req, res) => {
    const session = await requireGitHubSession(req, res);
    const [owner, repo] = repositoryName(req.query.full_name) || [];
    const number = Number(req.query.number);
    if (!owner || !repo || !Number.isSafeInteger(number) || number < 1) throw new GitHubError(400, 'Choose a valid issue.');
    const issue = await githubFetch(`/repos/${owner}/${repo}/issues/${number}`, session.token, fetchImpl);
    return res.json({ issue: serializeIssue(issue) });
  }));

  router.get('/pull', handle(async (req, res) => {
    const session = await requireGitHubSession(req, res);
    const [owner, repo] = repositoryName(req.query.full_name) || [];
    const number = Number(req.query.number);
    if (!owner || !repo || !Number.isSafeInteger(number) || number < 1) throw new GitHubError(400, 'Choose a valid pull request.');
    const pull = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`, session.token, fetchImpl);
    return res.json({ pullRequest: serializeIssue(pull) });
  }));

  router.get('/file', handle(async (req, res) => {
    const session = await requireGitHubSession(req, res);
    const [owner, repo] = repositoryName(req.query.full_name) || [];
    const path = req.query.path;
    if (!owner || !repo || !sourcePathAllowed(path)) throw new GitHubError(400, 'Choose a supported text or code file.');
    const url = `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(String(req.query.ref || ''))}`;
    const file = await githubFetch(url, session.token, fetchImpl);
    if (file.type !== 'file' || !Number.isSafeInteger(file.size) || file.size > MAX_FILE_BYTES || typeof file.content !== 'string') {
      throw new GitHubError(413, 'This file is too large or is not a supported text file (30 KB maximum).');
    }
    const content = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES || content.includes('\u0000')) throw new GitHubError(413, 'This file is too large or is not plain text.');
    return res.json({ path, content });
  }));

  return router;
}

export { openSession, sealSession, sourcePathAllowed };
