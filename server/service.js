'use strict';

/**
 * Installs AWS Profile Manager as a launchd agent, so it starts at login and
 * restarts if it crashes.
 *
 *   node server/service.js install | uninstall | status | restart
 *
 * The agent runs this repo's server with the Node that ran `install`. Node
 * from nvm lives in a versioned folder, so run `npm run service:install` again
 * after switching Node versions.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LABEL = 'local.aws-profile-manager';
const PORT = Number(process.env.PROFILE_MANAGER_PORT ?? 5005);
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const appHome = process.env.PROFILE_MANAGER_HOME || path.join(os.homedir(), '.aws-profile-manager');
const logFile = path.join(appHome, 'logs', 'service.log');
const domain = `gui/${process.getuid()}`;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist() {
    const entry = path.resolve(__dirname, 'index.js');
    const envPath = ['/opt/homebrew/bin', '/usr/local/bin', path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(entry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(path.resolve(__dirname, '..'))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(envPath)}</string>
    <key>PROFILE_MANAGER_PORT</key><string>${PORT}</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args, { quiet = false } = {}) {
    try {
        return execFileSync('launchctl', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        if (quiet) return null;
        throw error;
    }
}

async function health() {
    try {
        const resp = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
        return resp.ok;
    } catch {
        return false;
    }
}

async function waitForHealth(ms = 8000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await health()) return true;
        await new Promise((r) => setTimeout(r, 400));
    }
    return false;
}

async function install() {
    if (!fs.existsSync(path.resolve(__dirname, '..', 'frontend', 'dist', 'index.html'))) {
        console.error('The UI is not built. Run `npm run service:install` (it builds first) instead of calling this script directly.');
        process.exit(1);
    }
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    launchctl(['bootout', `${domain}/${LABEL}`], { quiet: true });
    fs.writeFileSync(plistPath, plist(), { mode: 0o644 });
    launchctl(['bootstrap', domain, plistPath]);
    const up = await waitForHealth();
    console.log(up
        ? `AWS Profile Manager is running and will start at login: http://localhost:${PORT}`
        : `Installed, but it isn't answering yet. Check ${logFile}`);
}

function uninstall() {
    launchctl(['bootout', `${domain}/${LABEL}`], { quiet: true });
    fs.rmSync(plistPath, { force: true });
    console.log('AWS Profile Manager service removed. Your ~/.aws files and ~/.aws-profile-manager are left as they are.');
}

async function status() {
    const installed = fs.existsSync(plistPath);
    const info = launchctl(['print', `${domain}/${LABEL}`], { quiet: true });
    const state = info?.match(/^\s*state = (.+)$/m)?.[1] ?? (installed ? 'not loaded' : 'not installed');
    const pid = info?.match(/^\s*pid = (\d+)$/m)?.[1];
    console.log(`launchd agent: ${state}${pid ? ` (pid ${pid})` : ''}`);
    console.log(`answering on http://localhost:${PORT}: ${(await health()) ? 'yes' : 'no'}`);
    console.log(`log: ${logFile}`);
}

async function restart() {
    launchctl(['kickstart', '-k', `${domain}/${LABEL}`]);
    console.log((await waitForHealth()) ? 'Restarted.' : `Restarted, but it isn't answering yet. Check ${logFile}`);
}

const commands = { install, uninstall, status, restart };
const command = commands[process.argv[2]];
if (!command) {
    console.error('usage: node server/service.js install | uninstall | status | restart');
    process.exit(1);
}
Promise.resolve(command()).catch((error) => {
    console.error(error.stderr?.toString() || error.message);
    process.exit(1);
});
