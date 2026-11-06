'use strict';

const { detectLifetime, defaultLifetime, lifetimeKey, snapLifetime } = require('./expiry');

const HOUR = 3600e3;
const SSO_ARN = 'arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_PowerUserAccess_0123456789abcdef/me@x.com';
const ok = (arn) => ({ ok: true, accountId: '111122223333', arn });

describe('pasted-key lifetimes', () => {
    test.each([
        ['assumed role', 'arn:aws:sts::111122223333:assumed-role/deploy/s', HOUR],
        ['GetSessionToken (IAM user)', 'arn:aws:iam::111122223333:user/ci', 12 * HOUR],
        ['GetFederationToken', 'arn:aws:sts::111122223333:federated-user/bob', 12 * HOUR],
        ['unknown', undefined, HOUR],
    ])('AWS default for %s', (_label, arn, ms) => expect(defaultLifetime(arn)).toBe(ms));

    test('keys are learned per account and role', () => {
        expect(lifetimeKey('111122223333', SSO_ARN)).toBe('111122223333:AWSReservedSSO_PowerUserAccess_0123456789abcdef');
        expect(lifetimeKey('111122223333', 'arn:aws:iam::111122223333:user/ci')).toBe('111122223333:user/ci');
        expect(lifetimeKey(null, SSO_ARN)).toBeNull();
    });

    test('an observed lifetime is rounded to the quarter hour', () => {
        expect(snapLifetime(57 * 60e3)).toBe(HOUR);
        expect(snapLifetime(2 * HOUR + 2 * 60e3)).toBe(2 * HOUR);
        expect(snapLifetime(3 * 60e3)).toBe(15 * 60e3);
    });

    test('Identity Center role: read from the role first, then learned, then the default', async () => {
        const key = lifetimeKey('111122223333', SSO_ARN);
        expect(await detectLifetime(ok(SSO_ARN), {}, async () => 8 * HOUR)).toEqual({ ms: 8 * HOUR, basis: 'role', key });
        expect(await detectLifetime(ok(SSO_ARN), { [key]: 4 * HOUR }, async () => null)).toEqual({ ms: 4 * HOUR, basis: 'learned', key });
        expect(await detectLifetime(ok(SSO_ARN), {}, async () => null)).toEqual({ ms: HOUR, basis: 'default', key });
    });

    test("other roles aren't read (their keys can be shorter than the role's maximum)", async () => {
        const readRoleMax = jest.fn(async () => 12 * HOUR);
        const r = await detectLifetime(ok('arn:aws:sts::111122223333:assumed-role/deploy/s'), {}, readRoleMax);
        expect(r).toMatchObject({ ms: HOUR, basis: 'default' });
        expect(readRoleMax).not.toHaveBeenCalled();
    });

    test("STS couldn't be reached: the default", async () => {
        expect(await detectLifetime({ ok: false, code: 'unreachable' }, {}, async () => null)).toEqual({ ms: HOUR, basis: 'default', key: null });
    });
});
