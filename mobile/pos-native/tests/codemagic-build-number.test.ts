import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../../codemagic.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const step = workflow.split('      - name: Set iOS build number\n')[1]
  .split('      - name: Generate native iOS project\n')[0].replace(/^ {10}/gm, '');
const code = step.split("node <<'NODE'\n")[1].split('\nNODE')[0];

function resolveBuild(latest: string, queryLog = '', project = '3', bundle = 'com.burin.storeos.pos') {
  let result: { expo: { ios: { buildNumber: string } } } | undefined;
  runInNewContext(code, {
    require: () => ({
      readFileSync: (path: string) => path === 'app.json'
        ? JSON.stringify({ expo: { ios: { buildNumber: '4', bundleIdentifier: 'com.burin.storeos.pos' } } })
        : queryLog,
      writeFileSync: (_path: string, value: string) => { result = JSON.parse(value); },
    }),
    process: { env: {
      PROJECT_BUILD_NUMBER: project, LATEST_TESTFLIGHT_BUILD_NUMBER: latest,
      BUILD_NUMBER_QUERY_LOG: 'query.log', APP_STORE_APP_ID: '6819038725', BUNDLE_ID: bundle,
    } },
    console: { log: () => {} },
  });
  return result?.expo.ios.buildNumber;
}

describe('Codemagic build numbering', () => {
  it('accepts the confirmed first-upload response seen in the Codemagic log', () => {
    expect(resolveBuild('', 'Did not find latest build for app 6819038725\n')).toBe('4');
  });
  it('increments a known Apple build', () => {
    expect(resolveBuild('99')).toBe('100');
  });
  it('recognizes the no-build diagnostic with CLI color codes', () => {
    expect(resolveBuild('', '\x1b[33mDid not find latest build for app 6819038725\x1b[0m\n')).toBe('4');
  });
  it('keeps increasing with the Codemagic project counter', () => {
    expect(resolveBuild('0', '', '9')).toBe('10');
  });
  it.each(['', '401 Unauthorized', 'Did not find latest build for app 1234567890', 'Did not find latest build for app 68190387250'])
    ('rejects an empty response without confirmed no-build evidence: %s', (log) => {
      expect(() => resolveBuild('', log)).toThrow();
    });
  it('rejects nonnumeric output even when the no-build diagnostic exists', () => {
    expect(() => resolveBuild('unknown', 'Did not find latest build for app 6819038725')).toThrow();
  });
  it('rejects missing project counter', () => {
    expect(() => resolveBuild('0', '', '')).toThrow();
  });
  it('rejects a different bundle identifier', () => {
    expect(() => resolveBuild('0', '', '3', 'com.other.app')).toThrow();
  });
  it('stops before Node when the Apple CLI fails, even with a no-build diagnostic', () => {
    const prefix = step.split("node <<'NODE'\n")[0].replace('cd "$CM_BUILD_DIR/mobile/pos-native"', ':');
    const mock = 'app-store-connect() { echo "Did not find latest build for app 6819038725" >&2; return 1; }\n';
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
    const execution = spawnSync(bash, ['-c', mock + prefix + '\necho NODE_REACHED'], {
      env: { ...process.env, APP_STORE_APP_ID: '6819038725' }, encoding: 'utf8',
    });
    expect(execution.status).toBe(1);
    expect(execution.stdout).not.toContain('NODE_REACHED');
    expect(execution.stderr).toContain('refusing to continue');
  });
});
