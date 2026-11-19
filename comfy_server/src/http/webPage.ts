import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../../web/', import.meta.url));
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2']
]);

export async function serveWebPage(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const entry = pathname === '/';
  const asset = /^\/assets\/[\w-][\w.-]*$/.test(pathname);
  if (!entry && !asset && pathname !== '/favicon.ico') return false;
  const file = entry ? 'index.html' : pathname.slice(1);
  const type = types.get(extname(file));
  if (!type) return false;
  let body: Buffer;
  try {
    body = await readFile(join(webRoot, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': asset ? 'public, max-age=31536000, immutable' : 'no-cache'
  });
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}
