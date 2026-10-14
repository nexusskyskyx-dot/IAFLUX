import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createGitHubRouter, openSession, sealSession, sourcePathAllowed } from './github.mjs';

const env = {
  GITHUB_APP_CLIENT_ID: 'test-client-id',
  GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
  GITHUB_SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
  GITHUB_OAUTH_CALLBACK_URL: 'http://localhost/api/github',
};

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function startApp(fetchImpl, testEnv = env) {
  const app = express();
  app.use(express.json());
  app.use('/api/github', createGitHubRouter({ env: testEnv, fetchImpl }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

function responseCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('set-cookie');
  return value ? value.split(/, (?=[^;,]+=)/) : [];
}

function cookiePair(value) { return value.split(';', 1)[0]; }

function mockGitHubFetch(requests) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, method: options.method || 'GET', headers: options.headers || {}, body: options.body || '' });
    if (parsed.hostname === 'github.com' && parsed.pathname === '/login/oauth/access_token') {
      return response({ access_token: 'ghu-test-user-token', token_type: 'bearer', expires_in: 28_800, refresh_token: 'ghr-test-refresh-token' });
    }
    if (parsed.hostname !== 'api.github.com') return response({ message: 'Not found' }, 404);
    const path = parsed.pathname;
    if (path === '/user') return response({ login: 'octocat' });
    if (path === '/user/installations') return response({ installations: [{ id: 7, account: { login: 'octo-org' }, permissions: { contents: 'read' } }] });
    if (path === '/user/installations/7/repositories') return response({ repositories: [{
      id: 42, name: 'private-repo', full_name: 'octo-org/private-repo', private: true,
      description: 'A private project', default_branch: 'main', html_url: 'https://github.com/octo-org/private-repo', updated_at: '2026-10-10T00:00:00Z',
    }] });
    if (path === '/repos/octo-org/private-repo') return response({
      full_name: 'octo-org/private-repo', description: 'A private project', private: true,
      default_branch: 'main', html_url: 'https://github.com/octo-org/private-repo',
    });
    if (path === '/repos/octo-org/private-repo/branches/main') return response({ commit: { commit: { tree: { sha: 'tree-sha' } } } });
    if (path === '/repos/octo-org/private-repo/git/trees/tree-sha') return response({
      truncated: false,
      tree: [
        { path: 'README.md', type: 'blob', size: 12 },
        { path: 'src/index.ts', type: 'blob', size: 19 },
        { path: '.env', type: 'blob', size: 10 },
        { path: 'id_rsa.key', type: 'blob', size: 20 },
        { path: 'assets/logo.png', type: 'blob', size: 100 },
        { path: 'node_modules/pkg/index.js', type: 'blob', size: 1 },
      ],
    });
    if (path === '/repos/octo-org/private-repo/issues') return response([
      { number: 4, title: 'Bug report', state: 'open', updated_at: '2026-10-12T00:00:00Z', html_url: 'https://github.com/octo-org/private-repo/issues/4', user: { login: 'octocat' }, body: 'Steps to reproduce.' },
      { number: 5, title: 'This is a pull request', state: 'open', pull_request: { url: 'https://api.github.com/pulls/5' }, user: { login: 'octocat' } },
    ]);
    if (path === '/repos/octo-org/private-repo/pulls') return response([
      { number: 9, title: 'Improve editor', state: 'open', updated_at: '2026-10-11T00:00:00Z', html_url: 'https://github.com/octo-org/private-repo/pull/9', user: { login: 'contributor' }, body: 'Editor improvements.' },
    ]);
    if (path === '/repos/octo-org/private-repo/issues/4') return response({ number: 4, title: 'Bug report', state: 'open', html_url: 'https://github.com/octo-org/private-repo/issues/4', user: { login: 'octocat' }, body: 'Full issue text.' });
    if (path === '/repos/octo-org/private-repo/pulls/9') return response({ number: 9, title: 'Improve editor', state: 'open', html_url: 'https://github.com/octo-org/private-repo/pull/9', user: { login: 'contributor' }, body: 'Full pull request description.' });
    if (path === '/repos/octo-org/private-repo/contents/README.md') return response({ type: 'file', encoding: 'base64', size: 12, content: Buffer.from('# Private repo').toString('base64') });
    if (path === '/repos/octo-org/private-repo/contents/invalid.txt') return response({ type: 'file', encoding: 'base64', size: 2, content: Buffer.from([0xff, 0xfe]).toString('base64') });
    return response({ message: 'Not found' }, 404);
  };
}

test('GitHub sessions are authenticated-encrypted and reject tampering or expiry', () => {
  const now = Date.now();
  const secret = env.GITHUB_SESSION_SECRET;
  const session = { token: 'ghu-token', login: 'octocat', issuedAt: now, expiresAt: now + 60_000 };
  const sealed = sealSession(session, secret);
  assert.deepEqual(openSession(sealed, secret, now), session);
  const [iv, tag, ciphertext] = sealed.split('.');
  const changedTag = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
  assert.equal(openSession(`${iv}.${changedTag}.${ciphertext}`, secret, now), null);
  assert.equal(openSession(sealed, 'a different session secret', now), null);
  assert.deepEqual(openSession(sealed, secret, now + 61_000), session); // Expired access tokens stay decryptable for server-side refresh.
  assert.equal(openSession(sealed, secret, now + 8 * 24 * 60 * 60 * 1000), null);
});

test('GitHub source browser excludes secret, binary, and generated paths', () => {
  assert.equal(sourcePathAllowed('src/App.tsx'), true);
  assert.equal(sourcePathAllowed('README.md'), true);
  assert.equal(sourcePathAllowed('.env'), false);
  assert.equal(sourcePathAllowed('config/.env.production'), false);
  assert.equal(sourcePathAllowed('id_rsa.key'), false);
  assert.equal(sourcePathAllowed('node_modules/pkg/index.js'), false);
  assert.equal(sourcePathAllowed('../outside.ts'), false);
  assert.equal(sourcePathAllowed('src/\u0001unsafe.ts'), false);
  assert.equal(sourcePathAllowed('assets/image.png'), false);
});

test('GitHub OAuth is state-checked and provides repository, issue, and PR context reads', async (t) => {
  const requests = [];
  const { server, base } = await startApp(mockGitHubFetch(requests));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const statusBefore = await fetch(`${base}/api/github?op=status`).then((result) => result.json());
  assert.deepEqual(statusBefore, { configured: true, connected: false, login: '' });
  const unauthorized = await fetch(`${base}/api/github/repos`);
  assert.equal(unauthorized.status, 401);

  const connect = await fetch(`${base}/api/github?op=connect`, { redirect: 'manual' });
  assert.equal(connect.status, 302);
  const authorization = new URL(connect.headers.get('location'));
  assert.equal(authorization.origin, 'https://github.com');
  assert.equal(authorization.pathname, '/login/oauth/authorize');
  assert.equal(authorization.searchParams.get('client_id'), env.GITHUB_APP_CLIENT_ID);
    assert.equal(authorization.searchParams.get('scope'), 'offline_access'); // GitHub Apps use fine-grained permissions; offline_access enables refresh tokens.
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('code_challenge')?.length, 43);
    const state = authorization.searchParams.get('state');
  const stateResponseCookie = responseCookies(connect.headers).find((value) => value.startsWith('aiflux_github_state='));
  assert.match(stateResponseCookie, /HttpOnly/);
  assert.match(stateResponseCookie, /SameSite=Lax/);
  const stateCookie = cookiePair(stateResponseCookie);
  assert.ok(stateCookie.startsWith('aiflux_github_state='));
  const [cookieState, codeVerifier] = decodeURIComponent(stateCookie.split('=', 2)[1]).split('.');
  assert.equal(cookieState, state);
  assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);

  const badCallback = await fetch(`${base}/api/github?code=code&state=wrong`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  assert.equal(badCallback.status, 400);
  const callback = await fetch(`${base}/api/github?code=valid-code&state=${encodeURIComponent(state)}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), 'http://localhost/?github=connected');
  const sessionResponseCookie = responseCookies(callback.headers).find((value) => value.startsWith('aiflux_github_session='));
  assert.match(sessionResponseCookie, /HttpOnly/);
  assert.match(sessionResponseCookie, /SameSite=Lax/);
  const sessionCookie = cookiePair(sessionResponseCookie);
  assert.ok(sessionCookie.startsWith('aiflux_github_session='));

  const statusAfter = await fetch(`${base}/api/github?op=status`, { headers: { cookie: sessionCookie } }).then((result) => result.json());
  assert.deepEqual(statusAfter, { configured: true, connected: true, login: 'octocat' });

  const repoListResponse = await fetch(`${base}/api/github/repos`, { headers: { cookie: sessionCookie } });
  assert.equal(repoListResponse.status, 200);
  const repoList = await repoListResponse.json();
  assert.equal(repoList.repos[0].fullName, 'octo-org/private-repo');
  assert.equal(repoList.repos[0].private, true);

  const detailsResponse = await fetch(`${base}/api/github/repo?full_name=octo-org%2Fprivate-repo`, { headers: { cookie: sessionCookie } });
  assert.equal(detailsResponse.status, 200);
  const details = await detailsResponse.json();
  assert.deepEqual(details.files.map((file) => file.path), ['README.md', 'src/index.ts']);
  assert.deepEqual(details.issues.map((issue) => issue.number), [4]);
  assert.deepEqual(details.pullRequests.map((pull) => pull.number), [9]);

  const issue = await fetch(`${base}/api/github/issue?full_name=octo-org%2Fprivate-repo&number=4`, { headers: { cookie: sessionCookie } }).then((result) => result.json());
  assert.equal(issue.issue.body, 'Full issue text.');
  const pull = await fetch(`${base}/api/github/pull?full_name=octo-org%2Fprivate-repo&number=9`, { headers: { cookie: sessionCookie } }).then((result) => result.json());
  assert.equal(pull.pullRequest.body, 'Full pull request description.');
  const file = await fetch(`${base}/api/github/file?full_name=octo-org%2Fprivate-repo&path=README.md&ref=main`, { headers: { cookie: sessionCookie } }).then((result) => result.json());
  assert.equal(file.content, '# Private repo');
  const invalidTextFile = await fetch(`${base}/api/github/file?full_name=octo-org%2Fprivate-repo&path=invalid.txt&ref=main`, { headers: { cookie: sessionCookie } });
  assert.equal(invalidTextFile.status, 413);
  const unsafeFile = await fetch(`${base}/api/github/file?full_name=octo-org%2Fprivate-repo&path=.env&ref=main`, { headers: { cookie: sessionCookie } });
  assert.equal(unsafeFile.status, 400);

  const githubApiRequests = requests.filter((request) => request.url.hostname === 'api.github.com');
  assert.ok(githubApiRequests.length > 0);
  assert.ok(githubApiRequests.every((request) => request.method === 'GET'));
  assert.ok(githubApiRequests.every((request) => request.headers.Authorization === 'Bearer ghu-test-user-token'));
  const exchange = requests.find((request) => request.url.hostname === 'github.com' && request.url.pathname.endsWith('/access_token'));
  assert.equal(exchange?.method, 'POST'); // OAuth code exchange only; no GitHub repository writes are performed.
  assert.equal(new URLSearchParams(exchange?.body).get('code_verifier'), codeVerifier);
});

test('GitHub status stays disabled without OAuth configuration', async (t) => {
  const { server, base } = await startApp(async () => response({}), {});
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const status = await fetch(`${base}/api/github?op=status`).then((result) => result.json());
  assert.deepEqual(status, { configured: false, connected: false, login: '' });
  const connect = await fetch(`${base}/api/github?op=connect`);
  assert.equal(connect.status, 503);
});

test('GitHub status refreshes an expired app user token server-side', async (t) => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, body: options.body ? Object.fromEntries(new URLSearchParams(String(options.body))) : {}, method: options.method || 'GET', headers: options.headers || {} });
    if (parsed.hostname === 'github.com' && parsed.pathname.endsWith('/access_token')) {
      const grant = Object.fromEntries(new URLSearchParams(String(options.body || '')));
      return response(grant.grant_type === 'refresh_token'
        ? { access_token: 'ghu-refreshed-token', expires_in: 28_800, refresh_token: 'ghr-next-token' }
        : { access_token: 'ghu-expiring-token', expires_in: 0.001, refresh_token: 'ghr-test-refresh-token' });
    }
    if (parsed.hostname === 'api.github.com' && parsed.pathname === '/user') return response({ login: 'octocat' });
    if (parsed.hostname === 'api.github.com' && parsed.pathname === '/user/installations') return response({ installations: [] });
    return response({ message: 'Not found' }, 404);
  };
  const { server, base } = await startApp(fetchImpl);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const connect = await fetch(`${base}/api/github?op=connect`, { redirect: 'manual' });
  const authorize = new URL(connect.headers.get('location'));
  const state = authorize.searchParams.get('state');
  const stateCookie = cookiePair(responseCookies(connect.headers).find((cookie) => cookie.startsWith('aiflux_github_state=')));
  const callback = await fetch(`${base}/api/github?code=code&state=${encodeURIComponent(state)}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  const sessionCookie = cookiePair(responseCookies(callback.headers).find((cookie) => cookie.startsWith('aiflux_github_session=')));
  const status = await fetch(`${base}/api/github?op=status`, { headers: { cookie: sessionCookie } });
  assert.deepEqual(await status.json(), { configured: true, connected: true, login: 'octocat' });
  const refreshedCookie = responseCookies(status.headers).find((cookie) => cookie.startsWith('aiflux_github_session='));
  assert.ok(refreshedCookie);
  const refreshedRequest = requests.find((request) => request.body.grant_type === 'refresh_token');
  assert.equal(refreshedRequest?.body.refresh_token, 'ghr-test-refresh-token');
  const repos = await fetch(`${base}/api/github/repos`, { headers: { cookie: cookiePair(refreshedCookie) } });
  assert.equal(repos.status, 200);
  assert.ok(requests.some((request) => request.headers.Authorization === 'Bearer ghu-refreshed-token'));
});

test('GitHub publishing previews branch state and requires same-origin, authenticated requests', async (t) => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, method: options.method || 'GET', headers: options.headers || {}, body: options.body || '' });
    return response({ message: 'Unexpected GitHub request' }, 404);
  };
  const { server, base } = await startApp(fetchImpl);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const session = { token: 'ghu-publish-token', login: 'octocat', issuedAt: Date.now(), expiresAt: Date.now() + 60 * 60_000 };
  const cookie = `aiflux_github_session=${encodeURIComponent(sealSession(session, env.GITHUB_SESSION_SECRET))}`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const body = {
    fullName: 'octo-org/private-repo', mode: 'pull_request', baseBranch: 'main', expectedBaseSha: 'a'.repeat(40),
    branchName: 'aiflux/ai-fix', commitMessage: 'Fix the editor',
    files: [{ path: 'src/editor.ts', content: 'export const fixed = true;\n' }],
  };

  const crossOrigin = await fetch(`${base}/api/github/changes`, {
    method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify(body),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(requests.length, 0);

  const noSession = await fetch(`${base}/api/github/changes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body),
  });
  assert.equal(noSession.status, 401);
  assert.equal(requests.length, 0);

  const unsafeFile = await fetch(`${base}/api/github/changes`, {
    method: 'POST', headers: { ...headers, Origin: base }, body: JSON.stringify({ ...body, files: [{ path: '.env', content: 'SECRET=value' }] }),
  });
  assert.equal(unsafeFile.status, 400);
  assert.equal(requests.length, 0);
});

test('GitHub branch list supports review and a confirmed publish creates a draft PR without force-pushing', async (t) => {
  const requests = [];
  const baseSha = 'a'.repeat(40);
  const baseTreeSha = 'b'.repeat(40);
  const changedTreeSha = 'c'.repeat(40);
  const commitSha = 'd'.repeat(40);
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(String(options.body)) : {};
    requests.push({ url: parsed, method, headers: options.headers || {}, body });
    if (parsed.hostname !== 'api.github.com') return response({ message: 'Unexpected host' }, 404);
    if (method === 'GET' && parsed.pathname === '/repos/octo-org/private-repo/branches') {
      return response([{ name: 'main', protected: true, commit: { sha: baseSha } }]);
    }
    if (method === 'GET' && parsed.pathname === '/repos/octo-org/private-repo') return response({ full_name: 'octo-org/private-repo', archived: false });
    if (method === 'GET' && parsed.pathname === '/repos/octo-org/private-repo/branches/main') {
      return response({ commit: { sha: baseSha, commit: { tree: { sha: baseTreeSha } } } });
    }
    if (method === 'POST' && parsed.pathname === '/repos/octo-org/private-repo/git/blobs') return response({ sha: 'blob-sha' }, 201);
    if (method === 'POST' && parsed.pathname === '/repos/octo-org/private-repo/git/trees') {
      assert.equal(body.base_tree, baseTreeSha);
      assert.deepEqual(body.tree.map(({ path, mode, type }) => ({ path, mode, type })), [{ path: 'src/editor.ts', mode: '100644', type: 'blob' }]);
      return response({ sha: changedTreeSha }, 201);
    }
    if (method === 'POST' && parsed.pathname === '/repos/octo-org/private-repo/git/commits') {
      assert.equal(body.tree, changedTreeSha);
      assert.deepEqual(body.parents, [baseSha]);
      assert.equal(body.message, 'Fix the editor');
      return response({ sha: commitSha, html_url: `https://github.com/octo-org/private-repo/commit/${commitSha}` }, 201);
    }
    if (method === 'POST' && parsed.pathname === '/repos/octo-org/private-repo/git/refs') {
      assert.equal(body.ref, 'refs/heads/aiflux/ai-fix');
      assert.equal(body.sha, commitSha);
      return response({ ref: 'refs/heads/aiflux/ai-fix' }, 201);
    }
    if (method === 'POST' && parsed.pathname === '/repos/octo-org/private-repo/pulls') {
      assert.equal(body.head, 'octo-org:aiflux/ai-fix');
      assert.equal(body.base, 'main');
      assert.equal(body.draft, true);
      return response({ html_url: 'https://github.com/octo-org/private-repo/pull/12' }, 201);
    }
    return response({ message: 'Unexpected GitHub request' }, 404);
  };
  const { server, base } = await startApp(fetchImpl);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const session = { token: 'ghu-publish-token', login: 'octocat', issuedAt: Date.now(), expiresAt: Date.now() + 60 * 60_000 };
  const cookie = `aiflux_github_session=${encodeURIComponent(sealSession(session, env.GITHUB_SESSION_SECRET))}`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: base };

  const branchList = await fetch(`${base}/api/github/branches?full_name=octo-org%2Fprivate-repo`, { headers: { Cookie: cookie } });
  assert.equal(branchList.status, 200);
  assert.deepEqual(await branchList.json(), { branches: [{ name: 'main', protected: true, commitSha: baseSha }] });

  const published = await fetch(`${base}/api/github/changes`, {
    method: 'POST', headers, body: JSON.stringify({
      fullName: 'octo-org/private-repo', mode: 'pull_request', baseBranch: 'main', expectedBaseSha: baseSha,
      branchName: 'aiflux/ai-fix', commitMessage: 'Fix the editor', pullRequestTitle: 'Fix the editor',
      pullRequestBody: 'Reviewed AI-assisted changes.', files: [{ path: 'src/editor.ts', content: 'export const fixed = true;\n' }],
    }),
  });
  assert.equal(published.status, 201);
  assert.deepEqual(await published.json(), {
    mode: 'pull_request', branch: 'aiflux/ai-fix',
    commitUrl: `https://github.com/octo-org/private-repo/commit/${commitSha}`,
    pullRequestUrl: 'https://github.com/octo-org/private-repo/pull/12', warning: '',
  });
  const apiWrites = requests.filter((request) => request.url.hostname === 'api.github.com' && request.method !== 'GET');
  assert.deepEqual(apiWrites.map((request) => request.method), ['POST', 'POST', 'POST', 'POST', 'POST']);
  assert.ok(requests.every((request) => request.headers.Authorization === 'Bearer ghu-publish-token'));
});

test('GitHub direct push updates only the reviewed branch and refuses stale branch snapshots', async (t) => {
  const requests = [];
  const baseSha = 'e'.repeat(40);
  const baseTreeSha = 'f'.repeat(40);
  const changedTreeSha = '1'.repeat(40);
  const commitSha = '2'.repeat(40);
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(String(options.body)) : {};
    requests.push({ url: parsed, method, body });
    if (parsed.hostname !== 'api.github.com') return response({ message: 'Unexpected host' }, 404);
    if (method === 'GET' && parsed.pathname === '/repos/octo-org/private-repo') return response({ archived: false });
    if (method === 'GET' && parsed.pathname === '/repos/octo-org/private-repo/branches/main') {
      return response({ commit: { sha: baseSha, commit: { tree: { sha: baseTreeSha } } } });
    }
    if (method === 'POST' && parsed.pathname === '/repos/octo-org/private-repo/git/blobs') return response({ sha: 'blob' }, 201);
    if (method === 'POST' && parsed.pathname === '/repos/octo-org/private-repo/git/trees') return response({ sha: changedTreeSha }, 201);
    if (method === 'POST' && parsed.pathname === '/repos/octo-org/private-repo/git/commits') return response({ sha: commitSha, html_url: 'https://github.com/octo-org/private-repo/commit/2' }, 201);
    if (method === 'PATCH' && parsed.pathname === '/repos/octo-org/private-repo/git/refs/heads/main') {
      assert.equal(body.sha, commitSha);
      assert.equal(body.force, false);
      return response({ ref: 'refs/heads/main' });
    }
    return response({ message: 'Unexpected GitHub request' }, 404);
  };
  const { server, base } = await startApp(fetchImpl);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const session = { token: 'ghu-publish-token', login: 'octocat', issuedAt: Date.now(), expiresAt: Date.now() + 60 * 60_000 };
  const cookie = `aiflux_github_session=${encodeURIComponent(sealSession(session, env.GITHUB_SESSION_SECRET))}`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: base };
  const payload = {
    fullName: 'octo-org/private-repo', mode: 'push', baseBranch: 'main', targetBranch: 'main', expectedBaseSha: baseSha,
    commitMessage: 'Fix the editor', files: [{ path: 'src/editor.ts', content: 'export const fixed = true;\n' }],
  };
  const pushed = await fetch(`${base}/api/github/changes`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(pushed.status, 201);
  assert.equal((await pushed.json()).mode, 'push');
  assert.ok(requests.some((request) => request.method === 'PATCH'));
  assert.ok(!requests.some((request) => request.url.pathname.endsWith('/git/refs')));

  requests.length = 0;
  const stale = await fetch(`${base}/api/github/changes`, {
    method: 'POST', headers, body: JSON.stringify({ ...payload, expectedBaseSha: '0'.repeat(40) }),
  });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /branch changed after your review/);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'GET']);
});
