'use strict';

/**
 * The local HTTP server: the API at POST /api and the built UI.
 *
 * It holds write access to ~/.aws, so it answers only this Mac's browser:
 *   - it listens on 127.0.0.1 and checks the peer is loopback;
 *   - the Host header must be localhost/127.0.0.1 on this port, which stops
 *     DNS rebinding (a page on evil.example pointed at 127.0.0.1);
 *   - a cross-site Origin is refused, and the API takes only JSON bodies, so a
 *     page on another site can't even send a simple request;
 *   - nothing reflects request text into a response.
 * Request bodies carry keys and are never logged; only the operation name is.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ValidationError, ConflictError } = require('../core/errors');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 64 * 1024;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const PAGE_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function send(res, status, headers, body = '') {
    res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

const sendJson = (res, status, value) => send(res, status, JSON_HEADERS, JSON.stringify(value));

function createRequestGuard({ port, devOrigins = [] }) {
    const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
    const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, ...devOrigins]);
    return function isAllowed(req) {
        if (!LOOPBACK.has(req.socket?.remoteAddress)) return false;
        if (!hosts.has((req.headers.host ?? '').toLowerCase())) return false;
        const origin = req.headers.origin;
        return !origin || origins.has(origin.toLowerCase());
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new ValidationError('Request too large.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function handleApi(req, res, operations, log) {
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { error: 'Send a JSON body (Content-Type: application/json).' });
        return;
    }
    let body;
    try {
        body = JSON.parse((await readBody(req)) || '{}');
    } catch (error) {
        sendJson(res, 400, { error: error instanceof ValidationError ? error.message : 'Invalid JSON body.' });
        return;
    }
    const operation = typeof body?.operation === 'string' ? body.operation : '';
    if (!Object.hasOwn(operations, operation)) {
        sendJson(res, 400, { error: 'Unknown operation.' });
        return;
    }
    // Not logged: the UI's polling, and the Claude hook, which runs before every command Claude runs.
    if (!['getState', 'pollSignIn', 'claudeHook'].includes(operation)) log.info(`operation=${operation}`);
    try {
        sendJson(res, 200, (await operations[operation](body.payload ?? {})) ?? {});
    } catch (error) {
        if (error instanceof ConflictError) sendJson(res, 409, { error: error.message, conflicts: error.conflicts });
        else if (error instanceof ValidationError) sendJson(res, 400, { error: error.message });
        else {
            log.error(`operation=${operation} failed: ${error?.name ?? 'Error'}`);
            sendJson(res, 500, { error: 'Something went wrong in the AWS Profile Manager service. Check ~/.aws-profile-manager/logs.' });
        }
    }
}

async function serveStatic(req, res, staticDir) {
    if (!staticDir) {
        send(res, 404, { 'Content-Type': 'text/plain' }, 'The UI is not built. Run `npm run build`, or use `npm start` for development.');
        return;
    }
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const resolved = path.resolve(staticDir, `.${urlPath}`);
    const inside = resolved === staticDir || resolved.startsWith(`${staticDir}${path.sep}`);
    let file = inside ? resolved : null;
    try {
        if (!file || (await fs.stat(file)).isDirectory()) file = path.join(staticDir, 'index.html');
    } catch {
        file = path.join(staticDir, 'index.html');
    }
    try {
        const content = await fs.readFile(file);
        const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
        const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
        res.writeHead(200, { ...PAGE_HEADERS, 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': cache });
        res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
        send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found.');
    }
}

function createHttpServer({ operations, port, staticDir = null, devOrigins = [], log = console }) {
    const isAllowed = createRequestGuard({ port, devOrigins });
    return http.createServer((req, res) => {
        (async () => {
            if (!isAllowed(req)) {
                sendJson(res, 403, { error: 'AWS Profile Manager only answers its own UI on this Mac.' });
                return;
            }
            const urlPath = (req.url ?? '/').split('?')[0];
            if (urlPath === '/api') {
                if (req.method !== 'POST') sendJson(res, 405, { error: 'Use POST.' });
                else await handleApi(req, res, operations, log);
                return;
            }
            if (urlPath === '/health') {
                sendJson(res, 200, { ok: true, service: 'aws-profile-manager' });
                return;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendJson(res, 405, { error: 'Method not allowed.' });
                return;
            }
            await serveStatic(req, res, staticDir);
        })().catch((error) => {
            log.error(`request failed: ${error?.name ?? 'Error'}`);
            if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
        });
    });
}

module.exports = { createHttpServer, createRequestGuard };
