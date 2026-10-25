import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Serves the built web app and forwards /api/ to the API on the same origin, like apps/web/nginx.conf
 * (session cookie and CSRF double-submit need one origin). Listens on 127.0.0.1 only.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** sha256 of each inline <script> in index.html, so the CSP needs no 'unsafe-inline' for scripts. */
function scriptHashes(indexHtml: string): string {
  const hashes: string[] = [];
  for (const m of indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.push(`'sha256-${createHash('sha256').update(m[1] ?? '').digest('base64')}'`);
  }
  return hashes.join(' ');
}

export class WebServer {
  private server: http.Server | null = null;
  apiPort = 0;

  constructor(private readonly webDir: string) {}

  private headers(urlPath: string, csp: string): Record<string, string> {
    return {
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cache-Control': urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
  }

  listen(port: number): Promise<number> {
    const root = path.resolve(this.webDir);
    const index = fs.readFileSync(path.join(root, 'index.html'));
    const csp =
      `default-src 'self'; script-src 'self' ${scriptHashes(index.toString('utf8'))}; style-src 'self' 'unsafe-inline'; ` +
      "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const upstream = http.request(
          { host: '127.0.0.1', port: this.apiPort, method: req.method, path: req.url, headers: req.headers },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'service_unavailable', message: 'The local service is restarting' }));
        });
        req.pipe(upstream);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      let file: string | null = null;
      try {
        const rel = decodeURIComponent(url.pathname);
        const candidate = path.resolve(root, `.${rel}`);
        if ((candidate === root || candidate.startsWith(root + path.sep)) && !candidate.endsWith('.map')) {
          if (fs.statSync(candidate).isFile()) file = candidate;
        }
      } catch {
        file = null;
      }
      // Missing build assets are real 404s; any other path is a client-side route.
      if (!file && url.pathname.startsWith('/assets/')) {
        res.writeHead(404, this.headers(url.pathname, csp)).end();
        return;
      }
      const body = file ? fs.readFileSync(file) : index;
      const type = file ? (TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream') : TYPES['.html']!;
      res.writeHead(200, { ...this.headers(file ? url.pathname : '/', csp), 'Content-Type': type, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
