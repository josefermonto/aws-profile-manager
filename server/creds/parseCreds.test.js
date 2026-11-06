'use strict';

const { parseCreds } = require('./parseCreds');
const { principalName } = require('./sts');

describe('parseCreds', () => {
    test('reads the portal credentials block and its account/role header', () => {
        const out = parseCreds(`[111122223333_AdministratorAccess]
aws_access_key_id=ASIAQWERTYUIOPASDFGH
aws_secret_access_key=secret/with+chars=
aws_session_token=IQoJb3JpZ2luX2VjE...==`);
        expect(out).toMatchObject({
            accessKeyId: 'ASIAQWERTYUIOPASDFGH', secretAccessKey: 'secret/with+chars=', sessionToken: 'IQoJb3JpZ2luX2VjE...==',
            accountId: '111122223333', roleName: 'AdministratorAccess', warnings: [],
        });
    });

    test.each([
        ['export AWS_ACCESS_KEY_ID="ASIAQWERTYUIOPASDFGH"\nexport AWS_SECRET_ACCESS_KEY="s"\nexport AWS_SESSION_TOKEN="t"'],
        ['set AWS_ACCESS_KEY_ID=ASIAQWERTYUIOPASDFGH\nset AWS_SECRET_ACCESS_KEY=s\nset AWS_SESSION_TOKEN=t'],
        ['$Env:AWS_ACCESS_KEY_ID="ASIAQWERTYUIOPASDFGH"\n$Env:AWS_SECRET_ACCESS_KEY="s"\n$Env:AWS_SESSION_TOKEN="t"'],
    ])('reads environment-variable forms', (blob) => {
        expect(parseCreds(blob)).toMatchObject({ accessKeyId: 'ASIAQWERTYUIOPASDFGH', secretAccessKey: 's', sessionToken: 't', warnings: [] });
    });

    test('warns about missing pieces', () => {
        expect(parseCreds('aws_access_key_id=ASIAQWERTYUIOPASDFGH').warnings).toEqual([
            'Missing aws_secret_access_key.',
            'Missing aws_session_token: temporary (ASIA…) keys need one.',
        ]);
        expect(parseCreds('').warnings).toEqual(['Nothing was pasted.']);
        expect(parseCreds('hello').warnings[0]).toMatch(/No AWS credentials/);
    });

    test('long-lived keys need no session token', () => {
        expect(parseCreds('aws_access_key_id=AKIAQWERTYUIOPASDFGH\naws_secret_access_key=s').warnings).toEqual([]);
    });
});

describe('principalName', () => {
    test.each([
        ['arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_PowerUserAccess_0123456789abcdef/me@example.com', 'PowerUserAccess'],
        ['arn:aws:sts::111122223333:assumed-role/deploy-role/session', 'deploy-role'],
        ['arn:aws:iam::111122223333:user/ci', 'user/ci'],
        [undefined, null],
    ])('%s → %s', (arn, name) => expect(principalName(arn)).toBe(name));
});
