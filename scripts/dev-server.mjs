// Local development server: serves public/, the API in api/, and built photos
// in panos/. Uses an in-memory database (see api/_lib/store.js), so no accounts
// are needed. Scores reset when the server stops.
//
//   npm start            -> http://localhost:8000

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

async function sendFile(res, file) {
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function handleApi(req, res, pathname) {
  const name = pathname.slice('/api/'.length);
  if (!/^[a-z-]+$/.test(name)) return sendFile(res, '');
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'api', `${name}.js`)).href);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return sendFile(res, '');
    throw err;
  }
  const handler = mod[req.method];
  if (!handler) {
    res.writeHead(405);
    return res.end();
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    // /panos/x.jpg (local photos) and /photos/x.jpg (the production proxy path)
    const photo = pathname.match(/^\/(?:panos|photos)\/([\w.-]+)$/);
    if (photo) return await sendFile(res, path.join(ROOT, 'panos', photo[1]));
    const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = path.join(ROOT, 'public', rel);
    if (!file.startsWith(path.join(ROOT, 'public'))) return sendFile(res, '');
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    return await sendFile(res, file);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end('Server error');
  }
}).listen(PORT, () => console.log(`Guess Cornell running at http://localhost:${PORT}`));
