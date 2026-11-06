'use strict';

const ini = require('./ini');

const SAMPLE = `# my aws config
[default]
region = us-east-1
output = json

; client A
[acme-dev]
region=eu-west-1
s3 =
  max_concurrent_requests = 20
cli_pager=

[profile other]
region = us-west-2
`;

describe('ini', () => {
    test('round-trips text byte for byte', () => {
        for (const text of [SAMPLE, SAMPLE.replace(/\n/g, '\r\n'), SAMPLE.trimEnd(), '', '\n', '[a]\nx=1']) {
            expect(ini.serialize(ini.parse(text))).toBe(text);
        }
    });

    test('reads top-level values, skipping comments and nested settings', () => {
        const doc = ini.parse(SAMPLE);
        expect(doc.sections.map((s) => s.name)).toEqual(['default', 'acme-dev', 'profile other']);
        expect(ini.values(ini.find(doc, 'acme-dev'))).toEqual({ region: 'eu-west-1', s3: '', cli_pager: '' });
    });

    test('patches keys in place and adds new ones before the blank separator', () => {
        const doc = ini.parse(SAMPLE);
        ini.upsert(doc, 'default', { region: 'us-east-2', cli_pager: '' });
        expect(ini.serialize(doc)).toContain('[default]\nregion = us-east-2\noutput = json\ncli_pager = \n\n; client A');
    });

    test('renames a bare section in place, keeping its other settings and position', () => {
        const doc = ini.parse(SAMPLE);
        ini.upsert(doc, 'profile acme-dev', {}, 'acme-dev');
        const out = ini.serialize(doc);
        expect(out).toContain('; client A\n[profile acme-dev]\nregion=eu-west-1\ns3 =\n  max_concurrent_requests = 20\ncli_pager=\n');
        expect(out.indexOf('[profile acme-dev]')).toBeLessThan(out.indexOf('[profile other]'));
        expect(ini.find(doc, 'acme-dev')).toBeNull();
    });

    test('appends new sections after a blank line', () => {
        const doc = ini.parse('[a]\nx = 1');
        ini.upsert(doc, 'b', { y: '2' });
        expect(ini.serialize(doc)).toBe('[a]\nx = 1\n\n[b]\ny = 2\n');
    });

    test('removing a key removes its nested lines', () => {
        const doc = ini.parse(SAMPLE);
        ini.upsert(doc, 'acme-dev', { s3: null });
        expect(ini.serialize(doc)).not.toContain('max_concurrent_requests');
    });

    test('removes sections and leaves the rest alone', () => {
        const doc = ini.parse(SAMPLE);
        ini.remove(doc, 'acme-dev');
        expect(ini.serialize(doc)).toBe(SAMPLE.replace(/\[acme-dev\][\s\S]*?\n\n/, ''));
    });

    test("removing a section keeps the comment that introduces the next one", () => {
        const doc = ini.parse(SAMPLE);
        ini.remove(doc, 'default');
        expect(ini.serialize(doc)).toBe(`# my aws config\n; client A\n${SAMPLE.slice(SAMPLE.indexOf('[acme-dev]'))}`);
    });

    test('fingerprints ignore trailing blank lines and whitespace, not content', () => {
        const a = ini.parse('[x]\nk = v\n\n\n').sections[0];
        const b = ini.parse('[x]\nk = v   \n').sections[0];
        const c = ini.parse('[x]\nk = w\n').sections[0];
        expect(ini.fingerprint(a)).toBe(ini.fingerprint(b));
        expect(ini.fingerprint(a)).not.toBe(ini.fingerprint(c));
        expect(ini.fingerprint(null)).toBeNull();
    });
});
