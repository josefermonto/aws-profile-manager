'use strict';

/**
 * Judges a shell command Claude Code is about to run (the PreToolUse hook).
 * Pure: the command and what the app knows about its profiles in, a verdict out.
 *
 *   deny  credentials would land in the conversation; ~/.aws edited behind the
 *         app's back; an AWS call with no profile named; a profile whose
 *         sign-in or keys have expired (the reason says how to fix it).
 *   ask   a change in a Prod-labeled account; a profile from another project
 *         than the one this folder is linked to.
 *   null  anything else: the normal permission flow decides.
 *
 * Commands are split the way a shell would (; && || | & newlines, outside
 * quotes), so each AWS call in a chain is judged on its own.
 */

/** Simple commands in `command`: `{ words, pipedOut }`, quotes removed. `pipedOut`: output goes to a pipe, not the screen. */
function splitCommand(command) {
    const segments = [];
    let words = [];
    let word = '';
    let inWord = false;
    let quote = null;
    const endWord = () => {
        if (inWord) words.push(word);
        word = '';
        inWord = false;
    };
    const endSegment = (pipedOut) => {
        endWord();
        if (words.length) segments.push({ words, pipedOut });
        words = [];
    };
    for (let i = 0; i < command.length; i += 1) {
        const c = command[i];
        if (quote) {
            if (c === quote) quote = null;
            else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
            else word += c;
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            inWord = true;
        } else if (c === '\\' && i + 1 < command.length) {
            word += command[++i];
            inWord = true;
        } else if (c === ' ' || c === '\t') {
            endWord();
        } else if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '`') {
            endSegment(false);
        } else if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) {
            word += c; // 2>&1, &>file
            inWord = true;
        } else if (c === '&') {
            if (command[i + 1] === '&') i += 1;
            endSegment(false);
        } else if (c === '|') {
            if (command[i + 1] === '|') {
                i += 1;
                endSegment(false);
            } else {
                endSegment(true);
            }
        } else {
            word += c;
            inWord = true;
        }
    }
    endSegment(false);
    return segments;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const WRAPPERS = new Set(['sudo', 'time', 'nice', 'nohup', 'command', 'exec', 'caffeinate']);
const base = (word) => word.split('/').pop();

// aws options that take a value before the service name.
const AWS_VALUE_OPTIONS = new Set(['--profile', '--region', '--output', '--query', '--endpoint-url', '--color', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout', '--cli-binary-format']);
// Operation names that only read.
const AWS_READ = /^(describe|list|get|head|batch-get|query|scan|search|select|lookup|filter|validate|estimate|simulate|preview|tail|wait|help|decode|detect|download|start-query|stop-query)(-|$)/;
// Calls whose output is credentials: fine into a pipe (`| docker login --password-stdin`), not onto the screen.
const SECRET_OUTPUT = new Set(['sts get-session-token', 'sts assume-role', 'sts assume-role-with-saml', 'sts assume-role-with-web-identity', 'sts get-federation-token', 'sso get-role-credentials', 'ecr get-login-password', 'ecr-public get-login-password', 'codeartifact get-authorization-token', 'configure export-credentials']);
const SECRET_SETTING = /secret|session_token|access_key/i;
const CONFIGURE_EDITS = new Set(['set', 'import', 'sso', 'sso-session', 'add-model']);
const CREDENTIAL_FILES = /\.aws\/(credentials|sso\/cache)/;

const CDK_LOCAL = new Set(['init', 'doctor', 'docs', 'acknowledge', 'ack', 'notices', 'version', 'context', 'synth', 'synthesize', 'ls', 'list', 'flags', 'metadata']);
const CDK_READ = new Set([...CDK_LOCAL, 'diff', 'drift']);
const SAM_LOCAL = new Set(['init', 'build', 'validate', 'local', 'docs']);
const SAM_READ = new Set([...SAM_LOCAL, 'logs', 'list', 'traces']);
const TERRAFORM_CHANGES = new Set(['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock', 'state']);

/**
 * The AWS tool call in one simple command, or `{ exportsProfile }` for
 * `export AWS_PROFILE=…` (it carries over to the rest of the chain).
 */
function parseCall(words, profileFromChain) {
    let i = 0;
    let profile = profileFromChain;
    if (words[0] === 'export' || words[0] === 'unset') {
        for (const w of words.slice(1)) {
            if (words[0] === 'unset' && w === 'AWS_PROFILE') return { exportsProfile: null };
            const m = w.match(ASSIGNMENT);
            if (m && m[1] === 'AWS_PROFILE') return { exportsProfile: m[2] };
        }
        return null;
    }
    for (;;) {
        const w = words[i];
        if (w === undefined) return null;
        const m = w.match(ASSIGNMENT);
        if (m) {
            if (m[1] === 'AWS_PROFILE') profile = m[2];
            i += 1;
        } else if (WRAPPERS.has(w) || w === 'env' || (words[0] === 'env' && w.startsWith('-'))) {
            i += 1;
        } else if (w === 'npx' || w === 'bunx') {
            i += 1;
            while (words[i]?.startsWith('-')) i += 1;
        } else {
            break;
        }
    }
    const tool = base(words[i]) === 'aws-cdk' ? 'cdk' : base(words[i]) === 'tofu' ? 'terraform' : base(words[i]);
    const args = words.slice(i + 1);
    const text = words.slice(i).join(' ');
    if (tool === 'aws') return { tool, ...awsArgs(args, profile), text };
    if (tool === 'cdk' || tool === 'sam' || tool === 'terraform') {
        let sub = null;
        for (let j = 0; j < args.length; j += 1) {
            if (args[j] === '--profile') profile = args[j + 1] ?? profile;
            else if (args[j].startsWith('--profile=')) profile = args[j].slice('--profile='.length);
            else if (sub === null && !args[j].startsWith('-')) sub = args[j];
        }
        if (args.includes('--version')) sub = 'version';
        return { tool, sub, profile, text };
    }
    return { tool, args, text };
}

function awsArgs(args, profile) {
    const positionals = [];
    for (let j = 0; j < args.length; j += 1) {
        const w = args[j];
        if (w === '--profile') profile = args[++j] ?? profile;
        else if (w.startsWith('--profile=')) profile = w.slice('--profile='.length);
        else if (AWS_VALUE_OPTIONS.has(w)) j += 1;
        else if (!w.startsWith('-')) positionals.push(w);
    }
    const [service = null, op = null] = positionals;
    return { profile, service, op, paths: positionals.slice(2), version: args.includes('--version') };
}

/** Whether an AWS tool call changes resources (rather than only reading). */
function changes(call) {
    if (call.tool === 'cdk') return !CDK_READ.has(call.sub);
    if (call.tool === 'sam') return !SAM_READ.has(call.sub);
    if (call.tool === 'terraform') return TERRAFORM_CHANGES.has(call.sub);
    const { service, op, paths } = call;
    if (!service || !op || service === 'configure' || service === 'help') return false;
    if (service === 's3') {
        if (op === 'ls' || op === 'presign') return false;
        if (op === 'cp' || op === 'sync') return String(paths[1] ?? '').startsWith('s3://');
        return true; // mv, rm, mb, rb, website
    }
    if (service === 'sso' || service === 'sso-oidc') return false;
    return !AWS_READ.test(op);
}

/** Whether the call reaches AWS, so it needs a profile named. */
function needsProfile(call) {
    if (call.tool === 'cdk') return !CDK_LOCAL.has(call.sub) && call.sub !== null;
    if (call.tool === 'sam') return !SAM_LOCAL.has(call.sub) && call.sub !== null && call.sub !== 'version';
    if (call.tool !== 'aws') return false;
    return Boolean(call.service) && !call.version && !['configure', 'help', 'sso', 'sso-oidc'].includes(call.service) && call.op !== 'help';
}

const isProd = (label) => /\bprod(uction)?\b|\bprd\b/i.test(label ?? '');

/**
 * `known`: `{ profiles: Map<name, { projectId, projectName, label, account, state, fix }>, folderProject: { id, name } | null }`,
 * or null when the app isn't reachable (then only the checks that need no state run).
 * `contextCommand`: how Claude lists this folder's profiles, for the reasons.
 * Returns `{ decision: 'deny' | 'ask' | null, reason }`.
 */
function evaluate(command, known, { contextCommand = 'awspm-claude context' } = {}) {
    const denies = [];
    const asks = [];
    let chainProfile;
    for (const { words, pipedOut } of splitCommand(String(command ?? ''))) {
        if (words.some((w) => CREDENTIAL_FILES.test(w))) {
            denies.push("~/.aws/credentials and ~/.aws/sso/cache hold secrets; don't read them. Run AWS commands with --profile instead.");
            continue;
        }
        const call = parseCall(words, chainProfile);
        if (!call) continue;
        if ('exportsProfile' in call) {
            chainProfile = call.exportsProfile ?? undefined;
            continue;
        }
        if (call.tool === 'aws') {
            const pair = `${call.service} ${call.op}`;
            if (SECRET_OUTPUT.has(pair) && !pipedOut) {
                denies.push(`\`aws ${pair}\` prints credentials into the conversation. Don't; use --profile with the command that needs them.`);
                continue;
            }
            if (call.service === 'configure' && call.op === 'get' && call.paths.some((p) => SECRET_SETTING.test(p))) {
                denies.push('That prints a secret from ~/.aws. Don\'t; use --profile with the command that needs it.');
                continue;
            }
            if (call.service === 'configure' && CONFIGURE_EDITS.has(call.op)) {
                denies.push('Profiles are managed in AWS Profile Manager (http://localhost:5005). Ask the user to change them there instead of editing ~/.aws.');
                continue;
            }
        }
        if (!['aws', 'cdk', 'sam', 'terraform'].includes(call.tool)) continue;
        if (!call.profile) {
            if (needsProfile(call)) {
                denies.push(`Name the AWS profile explicitly (\`--profile <name>\`, or \`AWS_PROFILE=<name>\` before ${call.tool}). \`${contextCommand}\` lists this folder's profiles.`);
            }
            continue;
        }
        const info = known?.profiles?.get(call.profile);
        if (!info) continue;
        const signingIn = call.tool === 'aws' && call.service === 'sso' && call.op === 'login';
        if (['expired', 'signed-out', 'error'].includes(info.state) && !signingIn && needsProfile(call)) {
            denies.push(`${call.profile} can't be used right now: ${info.fix}`);
            continue;
        }
        if (known.folderProject && info.projectId !== known.folderProject.id) {
            asks.push(`${call.profile} belongs to project ${info.projectName}, but this folder is linked to ${known.folderProject.name}.`);
        }
        if (isProd(info.label) && changes(call)) {
            asks.push(`${call.profile} is in a Prod account (${info.account}), and \`${call.text.slice(0, 120)}\` changes resources there.`);
        }
    }
    if (denies.length) return { decision: 'deny', reason: denies.join(' ') };
    if (asks.length) return { decision: 'ask', reason: asks.join(' ') };
    return { decision: null, reason: null };
}

module.exports = { splitCommand, parseCall, changes, needsProfile, evaluate, isProd };
