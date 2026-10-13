import app from '../server/api-app.mjs';

// Vercel invokes one function per file. Normalize the path so the same
// validated API routes work in both serverless and the local Node server.
export default function handler(req, res) {
  const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  req.url = '/api/config' + query;
  return app(req, res);
}
