// Private puzzle preview, on this computer only (nothing is deployed or scored).
//
//   npm run preview   -> http://localhost:8124
//
// Paste a day's list (the JSON array, or the whole Upstash SET command) to step
// through its rounds in 360°, with names, fun facts and the answer pin.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8124;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg' };

const FILES = {
  '/': 'scripts/preview.html',
  '/locations.json': 'data/locations.json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = FILES[url.pathname];
  const photo = url.pathname.match(/^\/panos\/([0-9a-f]{16}\.jpg)$/);
  if (photo) file = path.join('panos', photo[1]);
  try {
    if (!file) throw new Error('not found');
    const body = await readFile(path.join(ROOT, file));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(PORT, () => console.log(`Puzzle preview: http://localhost:${PORT}`));
