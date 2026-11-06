'use strict';

/**
 * What Claude Code runs (through ~/.aws-profile-manager/bin/awspm-claude):
 *
 *   awspm-claude context           this folder's project profiles, with live status
 *   awspm-claude link "<project>"  links this repo (or folder) to a project
 *   awspm-claude hook              the PreToolUse hook: reads Claude's JSON on stdin,
 *                                  prints a deny/ask decision, or nothing
 *
 * It asks the running service. When the service is down, `hook` still applies
 * the checks that need no state (credentials, a profile named), and never
 * blocks anything else.
 */
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { evaluate } = require('./policy');

const PORT = Number(process.env.PROFILE_MANAGER_PORT ?? 5005);
const NOT_RUNNING = `AWS Profile Manager isn't answering on http://localhost:${PORT}. Ask the user to start it (in its repo: npm run service:install, or npm run service:restart).`;

function call(operation, payload, timeoutMs) {
    const body = JSON.stringify({ operation, payload });
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: PORT, path: '/api', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { text += chunk; });
                res.on('end', () => {
                    let json = {};
                    try { json = JSON.parse(text); } catch { /* not JSON */ }
                    if (res.statusCode === 200) resolve(json);
                    else reject(Object.assign(new Error(json.error ?? `HTTP ${res.statusCode}`), { answered: true }));
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body);
    });
}

function readStdin() {
    return new Promise((resolve) => {
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { text += chunk; });
        process.stdin.on('end', () => resolve(text));
    });
}

/** The repo root when inside a git repo, else the current folder. */
function folderToLink() {
    try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || process.cwd();
    } catch {
        return process.cwd();
    }
}

async function hook() {
    let input;
    try {
        input = JSON.parse(await readStdin());
    } catch {
        return;
    }
    if (input?.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') return;
    let verdict;
    try {
        verdict = await call('claudeHook', { cwd: input.cwd, command: input.tool_input.command }, 4000);
    } catch (error) {
        if (error.answered) return;
        verdict = evaluate(input.tool_input.command, null);
    }
    if (!verdict?.decision) return;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: `AWS Profile Manager: ${verdict.reason}` },
    }));
}

async function main([command, ...args]) {
    if (command === 'hook') return hook();
    try {
        if (command === 'context') {
            process.stdout.write(`${(await call('claudeContext', { cwd: process.cwd() }, 8000)).text}\n`);
        } else if (command === 'link' && args.length) {
            process.stdout.write(`${(await call('claudeLink', { project: args.join(' '), folder: folderToLink() }, 8000)).text}\n`);
        } else {
            process.stdout.write('Usage: awspm-claude context | awspm-claude link "<project>"\n');
            process.exitCode = 2;
        }
    } catch (error) {
        process.stdout.write(`${error.answered ? error.message : NOT_RUNNING}\n`);
        process.exitCode = 1;
    }
}

main(process.argv.slice(2));
