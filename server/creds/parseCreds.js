'use strict';

/**
 * Parses pasted credentials, in any of the forms the AWS access portal offers:
 *
 *   [123456789012_AdministratorAccess]        ← credentials-file block (the header
 *   aws_access_key_id=ASIA…                     names the account and role)
 *   aws_secret_access_key=…
 *   aws_session_token=…
 *
 *   export AWS_ACCESS_KEY_ID="ASIA…"          ← macOS/Linux environment variables
 *   set AWS_ACCESS_KEY_ID=ASIA…               ← Windows cmd
 *   $Env:AWS_ACCESS_KEY_ID="ASIA…"            ← PowerShell
 *
 * Runs on the server, so the keys go from the paste box straight to
 * ~/.aws/credentials.
 */
const KEY_MAP = {
    aws_access_key_id: 'accessKeyId',
    aws_secret_access_key: 'secretAccessKey',
    aws_session_token: 'sessionToken',
    aws_security_token: 'sessionToken',
};

const HEADER_RE = /^\[(.+)\]$/;
const PORTAL_HEADER_RE = /^(\d{12})_(.+)$/;
const ENV_PREFIX_RE = /^(?:export\s+|set\s+|\$env:)/i;
const ACCESS_KEY_RE = /^(AKIA|ASIA)[A-Z0-9]{12,124}$/;

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2').trim();

function readLine(raw) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return null;
    const header = HEADER_RE.exec(line);
    if (header) return { kind: 'header', name: header[1].trim() };
    const stripped = line.replace(ENV_PREFIX_RE, '');
    const separator = stripped.indexOf('=');
    if (separator === -1) return null;
    const field = KEY_MAP[stripped.slice(0, separator).trim().toLowerCase()];
    return field ? { kind: 'value', field, value: unquote(stripped.slice(separator + 1)) } : null;
}

/**
 * `{ accessKeyId, secretAccessKey, sessionToken, profileName, accountId, roleName, warnings }`.
 * The first usable credential set wins when several are pasted.
 */
function parseCreds(input) {
    const out = { warnings: [] };
    if (!input || !String(input).trim()) {
        out.warnings.push('Nothing was pasted.');
        return out;
    }
    const sets = [];
    let current = null;
    for (const raw of String(input).split(/\r?\n/)) {
        const parsed = readLine(raw);
        if (!parsed) continue;
        if (parsed.kind === 'header') {
            current = { name: parsed.name, values: {} };
            sets.push(current);
            continue;
        }
        if (!current) {
            current = { name: null, values: {} };
            sets.push(current);
        }
        current.values[parsed.field] ??= parsed.value;
    }
    const chosen = sets.find((s) => s.values.accessKeyId && s.values.secretAccessKey) ?? sets[0];
    if (!chosen) {
        out.warnings.push('No AWS credentials found. Paste the block from the access portal.');
        return out;
    }
    if (sets.filter((s) => s.values.accessKeyId).length > 1) {
        out.warnings.push('Several credential sets were pasted; the first complete one was used.');
    }
    Object.assign(out, chosen.values);
    if (chosen.name) {
        out.profileName = chosen.name;
        const portal = PORTAL_HEADER_RE.exec(chosen.name);
        if (portal) {
            out.accountId = portal[1];
            out.roleName = portal[2];
        }
    }
    if (out.accessKeyId && !ACCESS_KEY_RE.test(out.accessKeyId)) out.warnings.push("The access key ID doesn't look like an AWS key (AKIA… or ASIA…).");
    if (!out.accessKeyId) out.warnings.push('Missing aws_access_key_id.');
    if (!out.secretAccessKey) out.warnings.push('Missing aws_secret_access_key.');
    if (out.accessKeyId?.startsWith('ASIA') && !out.sessionToken) out.warnings.push('Missing aws_session_token: temporary (ASIA…) keys need one.');
    return out;
}

module.exports = { parseCreds };
