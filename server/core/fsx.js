'use strict';

/**
 * File helpers for files that hold secrets: owner-only modes, and writes that
 * land in one step (temp file in the same directory, fsync, rename), so a
 * crash or a concurrent reader never sees half a credentials file.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** The file's text, or null when it doesn't exist. */
async function readText(file) {
    try {
        return await fs.readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

/** Modification time in ms, or null when the file doesn't exist. */
async function mtimeMs(file) {
    try {
        return (await fs.stat(file)).mtimeMs;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
}

/**
 * Replaces `file` with `content` atomically. A symlinked file (dotfiles repos
 * often link ~/.aws/config) is written through to its target, so the link survives.
 */
async function writeAtomic(file, content, mode = FILE_MODE) {
    let target = file;
    try {
        target = await fs.realpath(file);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    await ensureDir(path.dirname(target));
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    const handle = await fs.open(tmp, 'wx', mode);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await fs.chmod(tmp, mode);
        await fs.rename(tmp, target);
    } catch (error) {
        await fs.rm(tmp, { force: true });
        throw error;
    }
}

/**
 * A mutex for async work: calls run one at a time, in order. A failed call
 * doesn't block the ones queued after it.
 */
function createLock() {
    let tail = Promise.resolve();
    return function withLock(fn) {
        const run = tail.then(() => fn());
        tail = run.catch(() => {});
        return run;
    };
}

module.exports = { readText, mtimeMs, ensureDir, writeAtomic, createLock, FILE_MODE, DIR_MODE };
