'use strict';

const net = require('node:net');
const { createHttpServer, createRequestGuard } = require('./server');
const { ConflictError, ValidationError } = require('../core/errors');
const { silentLog } = require('../test/helpers');

const req = (over = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:5005' }, ...over });

describe('request guard', () => {
    const allowed = createRequestGuard({ port: 5005, devOrigins: ['http://localhost:5006'] });
    test.each([
        ['this Mac, same origin', req({ headers: { host: 'localhost:5005', origin: 'http://localhost:5005' } }), true],
        ['the dev UI', req({ headers: { host: '127.0.0.1:5005', origin: 'http://localhost:5006' } }), true],
        ['no origin (top-level navigation)', req(), true],
        ['another device on the network', req({ socket: { remoteAddress: '192.168.1.20' } }), false],
        ['DNS rebinding (foreign Host)', req({ headers: { host: 'evil.example:5005' } }), false],
        ['a page on another site', req({ headers: { host: 'localhost:5005', origin: 'https://evil.example' } }), false],
        ['wrong port in Host', req({ headers: { host: 'localhost:8080' } }), false],
    ])('%s', (_label, request, ok) => expect(allowed(request)).toBe(ok));
});

describe('API', () => {
    let server;
    let port;
    beforeAll(async () => {
        port = await new Promise((resolve) => {
            const probe = net.createServer().listen(0, '127.0.0.1', () => {
                const p = probe.address().port;
                probe.close(() => resolve(p));
            });
        });
        const operations = {
            getState: async () => ({ ok: true }),
            conflict: async () => { throw new ConflictError('changed', [{ file: 'config', section: 'profile x' }]); },
            invalid: async () => { throw new ValidationError('bad input'); },
            crash: async () => { throw new Error('secret detail'); },
        };
        server = createHttpServer({ operations, port, log: silentLog });
        await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    });
    afterAll(() => new Promise((resolve) => server.close(resolve)));

    const call = (body, headers = { 'Content-Type': 'application/json' }) =>
        fetch(`http://127.0.0.1:${port}/api`, { method: 'POST', headers, body: JSON.stringify(body) });

    test('answers operations', async () => {
        const res = await call({ operation: 'getState' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    test('maps errors without leaking internals', async () => {
        expect((await call({ operation: 'conflict' })).status).toBe(409);
        expect(await (await call({ operation: 'invalid' })).json()).toEqual({ error: 'bad input' });
        const crash = await call({ operation: 'crash' });
        expect(crash.status).toBe(500);
        expect(JSON.stringify(await crash.json())).not.toContain('secret detail');
        expect((await call({ operation: '__proto__' })).status).toBe(400);
    });

    test('takes JSON bodies only', async () => {
        expect((await call({ operation: 'getState' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    });

    test('says the UI is not built when there is no static dir', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        expect(res.status).toBe(404);
    });
});
