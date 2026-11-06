'use strict';

/**
 * macOS alerts: a dialog with the fix one click away ("Sign in again", "Paste
 * new keys") and "Ignore". The action opens the app at that dialog in the
 * default browser. Uses the built-in osascript, nothing to install; text goes
 * in as arguments, never spliced into a script.
 *
 * One dialog per subject (`key`): a newer alert about the same sign-in or keys
 * replaces the one still on screen.
 */
const { execFile } = require('node:child_process');

const DIALOG = [
    'on run argv',
    'beep',
    'activate',
    'set answer to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Ignore", item 3 of argv} default button 2 with icon caution',
    'return button returned of answer',
    'end run',
].flatMap((line) => ['-e', line]);

function createNotifier({ platform = process.platform, run = execFile, log = console } = {}) {
    const showing = new Map(); // key → the osascript process showing its dialog

    /** Resolves when answered: 'action' (and the URL was opened), 'ignore', 'replaced', 'failed' or 'unsupported'. */
    function prompt({ title = 'AWS Profile Manager', message, action, url, key }) {
        if (platform !== 'darwin') return Promise.resolve('unsupported');
        showing.get(key)?.kill();
        return new Promise((resolve) => {
            const child = run('osascript', [...DIALOG, title, message, action], (error, stdout) => {
                if (showing.get(key) === child) showing.delete(key);
                if (error) {
                    if (error.killed) return resolve('replaced');
                    log.error(`alert failed: ${error.code ?? error.message}`);
                    return resolve('failed');
                }
                if (String(stdout).trim() !== action) return resolve('ignore');
                run('open', [url], (openError) => {
                    if (openError) log.error(`couldn't open the app: ${openError.code ?? openError.message}`);
                });
                return resolve('action');
            });
            showing.set(key, child);
        });
    }

    return { prompt };
}

module.exports = { createNotifier };
