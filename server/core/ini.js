'use strict';

/**
 * A section-preserving model of the AWS INI files.
 *
 * A document is the lines before the first header (`preamble`) plus ordered
 * sections, each holding its raw lines, header included. Sections the app
 * doesn't edit serialize back byte for byte, comments, spacing, nested
 * settings and all. Edits change only the lines they must.
 */
const crypto = require('node:crypto');

const HEADER_RE = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/;
const COMMENT_RE = /^\s*[#;]/;

const normaliseName = (raw) => raw.trim().replace(/\s+/g, ' ');

function parse(text) {
    const source = text ?? '';
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/);
    const trailingNewline = source.length > 0 && lines[lines.length - 1] === '';
    if (trailingNewline) lines.pop();
    if (source.length === 0) lines.length = 0;

    const doc = { eol, trailingNewline, preamble: [], sections: [] };
    let current = null;
    for (const line of lines) {
        const header = HEADER_RE.exec(line);
        if (header) {
            current = { name: normaliseName(header[1]), lines: [line] };
            doc.sections.push(current);
        } else if (current) {
            current.lines.push(line);
        } else {
            doc.preamble.push(line);
        }
    }
    return doc;
}

function serialize(doc) {
    const all = [...doc.preamble, ...doc.sections.flatMap((s) => s.lines)];
    if (all.length === 0) return '';
    return all.join(doc.eol) + (doc.trailingNewline ? doc.eol : '');
}

/**
 * Where the section's own settings end. What follows is blank separator lines
 * and comments that sit just above the next header, which belong to that next
 * section ("; client A" above [acme-dev]).
 */
function bodyEnd(lines) {
    let end = lines.length;
    while (end > 1 && (lines[end - 1].trim() === '' || COMMENT_RE.test(lines[end - 1]))) end -= 1;
    return end;
}

/** The comment lines at the end of a section that introduce the next one. */
function leadIn(lines) {
    const tail = lines.slice(bodyEnd(lines));
    const first = tail.findIndex((l) => COMMENT_RE.test(l));
    return first === -1 ? [] : tail.slice(first);
}

const isKeyLine = (line) => line.trim() !== '' && !COMMENT_RE.test(line) && !/^\s/.test(line) && line.includes('=');
const keyOf = (line) => line.slice(0, line.indexOf('=')).trim().toLowerCase();

/**
 * The section's top-level settings. Indented lines are nested settings of the
 * key above them (`s3 =` blocks) and are skipped; the first value of a key wins.
 */
function values(section) {
    const out = {};
    for (const line of section.lines.slice(1)) {
        if (!isKeyLine(line)) continue;
        const key = keyOf(line);
        if (!Object.hasOwn(out, key)) out[key] = line.slice(line.indexOf('=') + 1).trim();
    }
    return out;
}

function find(doc, name) {
    return doc.sections.find((s) => s.name === name) ?? null;
}

/**
 * A stable hash of what the section says: blank trailing lines and trailing
 * whitespace don't count, so re-spacing a file isn't reported as an edit.
 */
function fingerprint(section) {
    if (!section) return null;
    const lines = section.lines.slice(0, bodyEnd(section.lines)).map((l) => l.trimEnd());
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Removes a key line and any nested (indented) lines under it. */
function removeKeyAt(lines, index) {
    let end = index + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
    lines.splice(index, end - index);
}

/**
 * Sets (string) or removes (null) top-level keys in place; new keys go after
 * the last setting, before the blank lines that separate sections.
 */
function patchLines(lines, patch) {
    const next = [...lines];
    for (const [rawKey, value] of Object.entries(patch)) {
        const key = rawKey.toLowerCase();
        const index = next.findIndex((line, i) => i > 0 && isKeyLine(line) && keyOf(line) === key);
        if (value === null || value === undefined) {
            if (index !== -1) removeKeyAt(next, index);
        } else if (index !== -1) {
            next[index] = `${rawKey} = ${value}`;
        } else {
            next.splice(bodyEnd(next), 0, `${rawKey} = ${value}`);
        }
    }
    return next;
}

/** Makes sure the section before a new one ends with a blank line. */
function separateFromPrevious(doc) {
    const last = doc.sections[doc.sections.length - 1];
    if (last) {
        if (last.lines[last.lines.length - 1].trim() !== '') last.lines.push('');
    } else if (doc.preamble.length && doc.preamble[doc.preamble.length - 1].trim() !== '') {
        doc.preamble.push('');
    }
}

/**
 * Creates or edits section `name` with `patch` (see patchLines). When `name`
 * doesn't exist but `replaces` does, that section is renamed in place first
 * (keeping its other settings): how a bare `[x]` in config becomes `[profile x]`.
 * Returns the resulting section.
 */
function upsert(doc, name, patch = {}, replaces = null) {
    let section = find(doc, name);
    const old = replaces ? find(doc, replaces) : null;
    if (!section && old) {
        old.name = name;
        old.lines[0] = `[${name}]`;
        section = old;
    } else if (section && old) {
        doc.sections.splice(doc.sections.indexOf(old), 1);
    }
    if (!section) {
        separateFromPrevious(doc);
        section = { name, lines: [`[${name}]`] };
        doc.sections.push(section);
        doc.trailingNewline = true;
    }
    section.lines = patchLines(section.lines, patch);
    return section;
}

/**
 * Removes a section. Comments introducing the next section stay (moved to the
 * section before), and removing the last section also drops the blank line
 * that separated it, so add-then-remove leaves the file as it was.
 */
function remove(doc, name) {
    const index = doc.sections.findIndex((s) => s.name === name);
    if (index === -1) return false;
    const [removed] = doc.sections.splice(index, 1);
    const previous = index > 0 ? doc.sections[index - 1].lines : doc.preamble;
    previous.push(...leadIn(removed.lines));
    if (index === doc.sections.length) {
        const keep = index > 0 ? 1 : 0;
        while (previous.length > keep && previous[previous.length - 1].trim() === '') previous.pop();
    }
    return true;
}

module.exports = { parse, serialize, values, find, fingerprint, upsert, remove };
