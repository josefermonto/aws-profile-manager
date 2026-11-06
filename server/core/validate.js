'use strict';

/** Input checks for API payloads. Each returns the clean value or throws a ValidationError worded for the user. */
const { ValidationError } = require('./errors');

const REGION_RE = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_ID_RE = /^\d{12}$/;
const ROLE_NAME_RE = /^[\w+=,.@-]{1,64}$/;
// Access portal URLs: https://<id>.awsapps.com/start (or a custom subdomain), and https://<id>.portal.<region>.app.aws.
const PORTAL_HOST_RE = /(^|\.)(awsapps\.com|app\.aws)$/i;

function text(value, label, { max = 100, optional = false, re = null, reMessage = null } = {}) {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        if (optional) return null;
        throw new ValidationError(`${label} is required.`);
    }
    if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`);
    const clean = value.trim();
    if (clean.length > max) throw new ValidationError(`${label} is too long (${max} characters at most).`);
    if (re && !re.test(clean)) throw new ValidationError(reMessage ?? `${label} isn't valid.`);
    return clean;
}

const id = (value, label = 'ID') => text(value, label, { max: 36, re: UUID_RE, reMessage: `Unknown ${label.toLowerCase()}.` });

const region = (value, label = 'Region', optional = false) =>
    text(value, label, { max: 32, optional, re: REGION_RE, reMessage: `${label} must be an AWS region code, e.g. us-east-1.` });

function int(value, label, { min, max }) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${label} must be a whole number from ${min} to ${max}.`);
    return n;
}

function oneOf(value, label, options) {
    if (!options.includes(value)) throw new ValidationError(`${label} must be one of: ${options.join(', ')}.`);
    return value;
}

function array(value, label, { max = 100, min = 1 } = {}) {
    if (!Array.isArray(value) || value.length < min) throw new ValidationError(`Pick at least ${min} ${label.toLowerCase()}.`);
    if (value.length > max) throw new ValidationError(`Too many ${label.toLowerCase()} at once (${max} at most).`);
    return value;
}

/** A portal start URL, normalised: no browser route (…/start/#/), query or trailing slash. */
function startUrl(value) {
    const raw = text(value, 'Access portal URL', { max: 300 });
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new ValidationError('Enter your AWS access portal URL, e.g. https://my-company.awsapps.com/start.');
    }
    if (url.protocol !== 'https:' || !PORTAL_HOST_RE.test(url.hostname)) {
        throw new ValidationError('That is not an AWS access portal URL (…awsapps.com/start).');
    }
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
}

module.exports = { text, id, region, int, oneOf, array, startUrl, REGION_RE, ACCOUNT_ID_RE, ROLE_NAME_RE, UUID_RE };
