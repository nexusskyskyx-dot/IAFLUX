import app from '../../server/api-app.mjs';

export default function handler(req, res) {
  const queryIndex = req.url?.indexOf('?') ?? -1;
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
  req.url = `/api/models/discover${query}`;
  return app(req, res);
}
