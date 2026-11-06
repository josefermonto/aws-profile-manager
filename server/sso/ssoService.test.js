'use strict';

const { createSsoService, SessionEndedError } = require('./ssoService');
const { ValidationError } = require('../core/errors');

const TOKEN = { region: 'us-east-1', accessToken: 'a', expiresAt: '2026-11-05T12:00:00Z', refreshToken: 'r', clientId: 'c', clientSecret: 's' };
const awsError = (name, httpStatusCode) => Object.assign(new Error('UnknownError'), { name, $metadata: { httpStatusCode } });
const failingWith = (error) => createSsoService({ oidcClient: () => ({ send: async () => { throw error; } }) });

describe('refresh', () => {
    test("AWS's answer once a session is over (InvalidRequestException, 400) ends the sign-in", async () => {
        const error = await failingWith(awsError('InvalidRequestException', 400)).refresh(TOKEN).catch((e) => e);
        expect(error).toBeInstanceOf(SessionEndedError);
        expect(error.code).toBe('InvalidRequestException');
    });

    test.each([['InvalidGrantException', 400], ['UnauthorizedClientException', 400], ['AccessDeniedException', 403]])('%s ends it too', async (name, status) => {
        await expect(failingWith(awsError(name, status)).refresh(TOKEN)).rejects.toBeInstanceOf(SessionEndedError);
    });

    test.each([
        ['no answer (offline)', Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'Error', code: 'ENOTFOUND' })],
        ['a 5xx', awsError('InternalServerException', 500)],
        ['throttling', awsError('ThrottlingException', 429)],
    ])('%s is a blip, not an end', async (_label, error) => {
        const result = await failingWith(error).refresh(TOKEN).catch((e) => e);
        expect(result).toBeInstanceOf(ValidationError);
        expect(result).not.toBeInstanceOf(SessionEndedError);
    });
});
