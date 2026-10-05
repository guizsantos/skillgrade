/**
 * `skillgrade preview browser`: a local site over every skill's results under
 * the output directory. Serves viewer.html (the whole UI), /api/manifest.json
 * (built by docs.ts on each request, so it is always live) and the raw reports
 * at /raw/<skill>/<file>.json.
 */
import * as http from 'http';
import * as fs from 'fs-extra';
import * as path from 'path';
import { manifest } from './docs';

export function runBrowserPreview(outputBase: string, port: number = 3847) {
    const root = path.resolve(outputBase);
    const htmlPath = path.join(__dirname, '..', 'viewer.html');

    const send = (res: http.ServerResponse, code: number, body: string | Buffer, type: string) => {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(body);
    };

    const server = http.createServer(async (req, res) => {
        try {
            const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
            if (pathname === '/' || pathname === '/index.html') {
                return send(res, 200, await fs.readFile(htmlPath), 'text/html; charset=utf-8');
            }
            if (pathname === '/api/manifest.json') {
                return send(res, 200, JSON.stringify(await manifest(root)), 'application/json');
            }
            const parts = pathname.split('/').filter(Boolean);
            if (parts.length === 3 && parts[0] === 'raw' && parts[2].endsWith('.json')) {
                const base = path.join(root, parts[1], 'results');
                const file = path.resolve(base, parts[2]);
                // only a report inside some skill's results dir, never a path that climbs out of it
                if (path.dirname(file) === base && path.dirname(path.dirname(base)) === root && await fs.pathExists(file)) {
                    return send(res, 200, await fs.readFile(file), 'application/json');
                }
            }
            send(res, 404, 'not found', 'text/plain');
        } catch (err) {
            send(res, 500, String(err), 'text/plain');
        }
    });

    return new Promise<http.Server>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const addr = server.address();
            const actualPort = addr && typeof addr === 'object' ? addr.port : port;
            console.log(`\nskillgrade preview`);
            console.log(`\n  url       http://localhost:${actualPort}`);
            console.log(`  results   ${root}\n`);
            resolve(server);
        });
    });
}
