import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import app from './api-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const httpServer = createServer(app);
const port = Number(process.env.PORT) || 3000;

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server: httpServer }, allowedHosts: true },
    appType: 'custom',
  });
  app.use(vite.middlewares);
  app.use('*', async (req, res, next) => {
    try {
      const template = await readFile(path.join(root, 'index.html'), 'utf8');
      res.status(200).set({ 'Content-Type': 'text/html' }).end(await vite.transformIndexHtml(req.originalUrl, template));
    } catch (error) { next(error); }
  });
}

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`AIFLUX is ready on http://0.0.0.0:${port}`);
});
