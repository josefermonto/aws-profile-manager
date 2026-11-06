'use strict';

/**
 * The AWS Profile Manager service: serves the UI and API on 127.0.0.1, and runs
 * the expiry watcher. Started at login by launchd (`npm run service:install`),
 * or by `npm start` while developing (then Vite serves the UI on :5006).
 */
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('./context');
const { createHttpServer } = require('./http/server');
const { createOperations } = require('./http/operations');
const { ensureDir } = require('./core/fsx');

const PORT = Number(process.env.PROFILE_MANAGER_PORT ?? 5005);
const DEV = process.env.PROFILE_MANAGER_DEV === '1';
const DEV_UI_PORT = 5006;

async function main() {
    const ctx = createContext({ port: PORT });
    await ensureDir(ctx.paths.appHome);
    await ctx.shell.writeScript();
    await ctx.claude.ensure().catch((error) => console.error(`Claude sync: ${error.message}`));

    const dist = path.resolve(__dirname, '..', 'frontend', 'dist');
    const staticDir = !DEV && fs.existsSync(path.join(dist, 'index.html')) ? dist : null;
    const server = createHttpServer({
        operations: createOperations(ctx),
        port: PORT,
        staticDir,
        devOrigins: DEV ? [`http://localhost:${DEV_UI_PORT}`, `http://127.0.0.1:${DEV_UI_PORT}`] : [],
    });

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is in use. Is the AWS Profile Manager service already running? Check with: npm run service:status`);
        } else {
            console.error(`server error: ${error.code ?? error.message}`);
        }
        process.exit(1);
    });

    server.listen(PORT, '127.0.0.1', () => {
        const ui = DEV ? `http://localhost:${DEV_UI_PORT}` : `http://localhost:${PORT}`;
        console.log(`AWS Profile Manager listening on 127.0.0.1:${PORT}. Open ${ui}`);
        ctx.watcher.start();
    });

    const shutdown = () => {
        ctx.watcher.stop();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main().catch((error) => {
    console.error(`AWS Profile Manager failed to start: ${error.message}`);
    process.exit(1);
});
