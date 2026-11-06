'use strict';

const { splitCommand, parseCall, changes, evaluate } = require('./policy');

const profiles = new Map([
    ['acme-dev-admin', { projectId: 'acme', projectName: 'Acme', label: 'Dev', account: '111122223333', state: 'active', fix: '' }],
    ['acme-prod-admin', { projectId: 'acme', projectName: 'Acme', label: 'Prod', account: '444455556666', state: 'active', fix: '' }],
    ['acme-qa-admin', { projectId: 'acme', projectName: 'Acme', label: 'QA', account: '222222222222', state: 'expired', fix: 'the sign-in has expired. Ask the user to sign in again: http://localhost:5005/#sign-in=p1' }],
    ['globex-dev-admin', { projectId: 'globex', projectName: 'Globex', label: 'Dev', account: '111111111111', state: 'active', fix: '' }],
]);
const inAcme = { profiles, folderProject: { id: 'acme', name: 'Acme' } };
const verdict = (command, known = inAcme) => evaluate(command, known).decision;

describe('splitCommand', () => {
    test('splits chains and pipes outside quotes, keeps redirections', () => {
        expect(splitCommand(`export AWS_PROFILE=x && aws s3 ls 's3://a;b' 2>&1 | head -5; echo "done | ok"`)).toEqual([
            { words: ['export', 'AWS_PROFILE=x'], pipedOut: false },
            { words: ['aws', 's3', 'ls', 's3://a;b', '2>&1'], pipedOut: true },
            { words: ['head', '-5'], pipedOut: false },
            { words: ['echo', 'done | ok'], pipedOut: false },
        ]);
    });
});

describe('parseCall', () => {
    test.each([
        ['aws --region eu-west-1 --profile p lambda list-functions', { tool: 'aws', profile: 'p', service: 'lambda', op: 'list-functions' }],
        ['AWS_PROFILE=p aws s3 ls', { tool: 'aws', profile: 'p', service: 's3', op: 'ls' }],
        ['env AWS_PROFILE=p npx -y aws-cdk deploy --all', { tool: 'cdk', profile: 'p', sub: 'deploy' }],
        ['cdk deploy --profile=p MyStack', { tool: 'cdk', profile: 'p', sub: 'deploy' }],
        ['/usr/local/bin/aws --profile p sts get-caller-identity', { tool: 'aws', service: 'sts', op: 'get-caller-identity' }],
    ])('%s', (command, expected) => expect(parseCall(splitCommand(command)[0].words)).toMatchObject(expected));
});

describe('changes', () => {
    const call = (command) => parseCall(splitCommand(command)[0].words);
    test.each([
        ['aws ec2 describe-instances', false],
        ['aws logs tail /aws/lambda/x --follow', false],
        ['aws s3 cp s3://bucket/key ./local', false],
        ['aws s3 cp ./local s3://bucket/key', true],
        ['aws s3 rm s3://bucket/key', true],
        ['aws lambda update-function-code --function-name f --zip-file fileb://f.zip', true],
        ['aws lambda invoke --function-name f out.json', true],
        ['cdk diff', false],
        ['cdk deploy', true],
        ['sam deploy', true],
        ['terraform plan', false],
        ['terraform apply', true],
    ])('%s → %s', (command, expected) => expect(changes(call(command))).toBe(expected));
});

describe('evaluate', () => {
    test('credentials never go into the conversation', () => {
        expect(verdict('cat ~/.aws/credentials')).toBe('deny');
        expect(verdict('ls ~/.aws/sso/cache')).toBe('deny');
        expect(verdict('aws configure get aws_secret_access_key --profile acme-dev-admin')).toBe('deny');
        expect(verdict('aws configure export-credentials --profile acme-dev-admin')).toBe('deny');
        expect(verdict('aws sts assume-role --role-arn arn:aws:iam::1:role/x --role-session-name s --profile acme-dev-admin')).toBe('deny');
        // Into a pipe is fine: the password never shows.
        expect(verdict('aws ecr get-login-password --profile acme-dev-admin | docker login --username AWS --password-stdin 1.dkr.ecr.us-east-1.amazonaws.com')).toBe(null);
    });

    test('profiles are edited in the app, not with aws configure', () => {
        expect(verdict('aws configure set region eu-west-1 --profile acme-dev-admin')).toBe('deny');
        expect(verdict('aws configure list --profile acme-dev-admin')).toBe(null);
    });

    test('an AWS call must name its profile; local commands needn\'t', () => {
        const r = evaluate('aws s3 ls', inAcme, { contextCommand: '/x/awspm-claude context' });
        expect(r).toMatchObject({ decision: 'deny', reason: expect.stringContaining('/x/awspm-claude context') });
        expect(verdict('cdk deploy')).toBe('deny');
        expect(verdict('aws --version')).toBe(null);
        expect(verdict('cdk synth')).toBe(null);
        expect(verdict('sam build')).toBe(null);
        expect(verdict('export AWS_PROFILE=acme-dev-admin && cdk deploy')).toBe(null);
        expect(verdict('npm test && git status')).toBe(null);
    });

    test('an expired sign-in is refused with the way to fix it; signing in is not', () => {
        const r = evaluate('aws s3 ls --profile acme-qa-admin', inAcme);
        expect(r).toEqual({ decision: 'deny', reason: expect.stringContaining('#sign-in=p1') });
        expect(verdict('aws sso login --profile acme-qa-admin')).toBe(null);
    });

    test('Prod: reads run, changes ask first', () => {
        expect(verdict('aws lambda list-functions --profile acme-prod-admin')).toBe(null);
        const r = evaluate('AWS_PROFILE=acme-prod-admin cdk deploy --all', inAcme);
        expect(r).toEqual({ decision: 'ask', reason: expect.stringMatching(/Prod account \(444455556666\).*cdk deploy --all/) });
        expect(verdict('aws lambda list-functions --profile acme-dev-admin && aws s3 rm s3://b/k --profile acme-prod-admin')).toBe('ask');
    });

    test("another project's profile in this folder asks first", () => {
        expect(evaluate('aws s3 ls --profile globex-dev-admin', inAcme)).toEqual({ decision: 'ask', reason: expect.stringContaining('belongs to project Globex') });
        expect(verdict('aws s3 ls --profile globex-dev-admin', { profiles, folderProject: null })).toBe(null);
    });

    test('profiles the app does not manage, or no app: only the stateless checks', () => {
        expect(verdict('aws s3 rm s3://b/k --profile personal')).toBe(null);
        expect(verdict('aws s3 rm s3://b/k --profile acme-prod-admin', null)).toBe(null);
        expect(verdict('aws s3 ls', null)).toBe('deny');
        expect(verdict('cat ~/.aws/credentials', null)).toBe('deny');
    });
});
