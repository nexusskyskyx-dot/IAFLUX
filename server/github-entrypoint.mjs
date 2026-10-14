import app from './api-app.mjs';

export function githubFunction(pathname = '') {
  return function handler(req, res) {
    const queryIndex = req.url?.indexOf('?') ?? -1;
    const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
    req.url = `/api/github${pathname}${query}`;
    return app(req, res);
  };
}
