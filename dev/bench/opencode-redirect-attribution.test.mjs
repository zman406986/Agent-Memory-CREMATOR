/**
 * The two redirect records the `1d` run needed on the harness side.
 *
 * (a) A replay's session row was written by the seed, so the redirect was
 * recorded `not-applicable: seed-only` even when the host's own log names the
 * arm world and the seeded session. That was wrong: when the session id matches
 * the seed and that activity exists, the row is `pass` with `basis: seeded+host`;
 * a seed with no host activity is `fail`, and a missing row still fails.
 *
 * (b) The desktop opencode app (`opencode-cli.exe serve --service`) holds the
 * real data directory open and wrote its database during the `1d` run. A
 * detected host plus the real log's own lines at the stat-change second records
 * the change `not-applicable: concurrent-desktop-service` — only when the
 * writer record (pid, executable path, command line, start time) is complete;
 * otherwise the hard failure stands.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONCURRENT_DESKTOP_SERVICE_REASON, concurrentDesktopServiceRecord,
  desktopServiceProcesses, desktopServiceWriteEvidence, hostArmWorldEvidence,
  redirectHeldRecord,
} from './opencode-run.mjs';

const rows = [{ path: 'world/.local/share/opencode/opencode.db', exists: true, total: 1 }];
const sessionId = 'ses_RAC00NS5YNTH3T1C0000000000';
const service = {
  detected: true,
  processes: [{
    pid: 5248,
    commandline: '"C:\\Users\\TZhen\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.1.4-x64\\opencode-cli.exe" serve --service',
  }],
};

test('a seeded row whose session matches and whose host opened the arm world passes as seeded+host', () => {
  const record = redirectHeldRecord({ source: 'seeded' }, rows, true, {
    sessionId,
    seededSessionId: sessionId,
    hostEvidence: {
      ok: true,
      signals: ['host-log-names-session', 'host-log-names-arm-world'],
      why: 'the host\'s own log/DB activity shows it opened the arm world',
    },
  });
  assert.equal(record.status, 'pass');
  assert.equal(record.source, 'seeded+host');
  assert.equal(record.basis, 'seeded+host');
  assert.equal(record.caveat, null);
  assert.match(record.detail, /basis=seeded\+host/u);
});

test('a seeded row with no host activity fails seed-only', () => {
  const record = redirectHeldRecord({ source: 'seeded' }, rows, true, {
    sessionId,
    seededSessionId: sessionId,
    hostEvidence: { ok: false, signals: [], why: 'no host log' },
  });
  assert.equal(record.status, 'fail');
  assert.equal(record.source, 'seed-only');
  assert.equal(record.basis, 'seed-only');
  assert.match(record.detail, /the redirect itself is not witnessed/u);
  assert.match(record.detail, /the seed satisfied the row/u);
});

test('a session that does not match the seed is not accepted, and a missing row still fails', () => {
  const mismatch = redirectHeldRecord({ source: 'seeded' }, rows, true, {
    sessionId: 'ses_other',
    seededSessionId: sessionId,
    hostEvidence: { ok: true, signals: ['host-log-names-session'], why: 'log' },
  });
  assert.equal(mismatch.status, 'fail');
  assert.equal(mismatch.basis, 'seed-only');
  const missing = redirectHeldRecord({ source: 'seeded' }, rows, false, {
    sessionId,
    seededSessionId: sessionId,
    hostEvidence: { ok: true, signals: ['host-log-names-session'], why: 'log' },
  });
  assert.equal(missing.status, 'fail');
  assert.equal(missing.basis, null);
});

test('the host log names the arm world and the seeded session', () => {
  const worldDir = 'C:\\Users\\TZhen\\Desktop\\racoons\\scratchpad\\launch\\2026-11-10-opencode-36-test-1d\\test\\world';
  const logText = [
    `timestamp=2026-11-10T18:00:57.798Z level=INFO run=f6b4241b message="cli starting" `
      + `args="[\\"--standalone\\",\\"run\\",\\"task\\",\\"--session\\",\\"${sessionId}\\"]"`,
    `timestamp=2026-11-10T18:00:57.807Z level=INFO run=f6b4241b message="spawning process" `
      + `cwd="${worldDir.replace(/\\/gu, '\\\\')}\\work"`,
  ].join('\n');
  const evidence = hostArmWorldEvidence({ worldDir, sessionId, logText, logPath: 'arm.log' });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.sessionNamed, true);
  assert.equal(evidence.worldNamed, true);
  assert.deepEqual(evidence.signals,
    ['host-log-present', 'host-log-names-session', 'host-log-names-arm-world']);
  // A database write is the fallback when no log was written.
  const dbOnly = hostArmWorldEvidence({ sessionId, databaseChanged: true });
  assert.equal(dbOnly.ok, true);
  assert.deepEqual(dbOnly.signals, ['host-db-write']);
  assert.equal(hostArmWorldEvidence({ sessionId }).ok, false);
});

test('the desktop service is the serve --service process, not any opencode process', () => {
  assert.equal(desktopServiceProcesses(service.processes).detected, true);
  assert.equal(desktopServiceProcesses([
    { pid: 1, commandline: '"C:\\x\\opencode-cli.exe" run --standalone "task"' },
    { pid: 2, commandline: '"C:\\x\\opencode.exe" serve --stdio --port 0' },
  ]).detected, false);
  assert.equal(desktopServiceProcesses([]).detected, false);
});

test('the real log attributes the write to a run the arm child did not write', () => {
  const at = (ms) => new Date(ms).toISOString();
  const logText = [
    `timestamp=${at(4000)} level=INFO run=child message="cli starting"`,
    `timestamp=${at(5005)} level=INFO run=desk message=event event.type=provider.updated`,
    `timestamp=${at(5006)} level=INFO run=desk message=event event.type=model.updated`,
  ].join('\n');
  const evidence = desktopServiceWriteEvidence({
    changes: [{ path: 'C:/u/.local/share/opencode/opencode.db', why: 'mtime changed (1000 -> 5000)' }],
    logText,
    logPath: 'C:/u/.local/share/opencode/log/opencode.log',
    armRunIds: ['child'],
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.matched.length, 2);
  assert.equal(evidence.matched[0].run, 'desk');
  // A window that only holds the arm child's own lines names no alternative.
  const onlyChild = desktopServiceWriteEvidence({
    changes: [{ path: 'x.db', why: 'mtime changed (1000 -> 5000)' }],
    logText,
    armRunIds: ['child', 'desk'],
  });
  assert.equal(onlyChild.ok, false);
  assert.deepEqual(onlyChild.matched, []);
});

test('a detected service with log evidence records not-applicable: concurrent-desktop-service', () => {
  const hostLog = {
    path: 'C:/u/.local/share/opencode/log/opencode.log',
    windows: [[3000, 7000]],
    matched: [{ timestamp: '2026-11-10T18:14:30.707Z', run: '3c39e410', role: null, line: 'x' }],
    why: 'one line names another run',
  };
  const preflightAt = '2026-11-10T18:14:00.000Z';
  /** A complete writer record: pid, executable path, command line, start time. */
  const writer = {
    pid: 5248,
    executablePath: 'C:\\Users\\TZhen\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.1.4-x64\\opencode-cli.exe',
    commandline: '"C:\\Users\\TZhen\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.1.4-x64\\opencode-cli.exe" serve --service',
    startedAt: Date.parse('2026-11-10T18:00:00.000Z'),
  };
  const record = concurrentDesktopServiceRecord({
    realChanged: [{ path: 'C:/u/.local/share/opencode/opencode.db',
      why: 'mtime changed (1 -> 2)' }],
    service: { detected: true, processes: [writer], at: preflightAt },
    hostLog,
  });
  assert.equal(record.status, 'not-applicable');
  assert.equal(record.reason, CONCURRENT_DESKTOP_SERVICE_REASON);
  assert.match(record.detail, /5248/u);
  assert.match(record.detail, /serve --service/u);
  assert.match(record.detail, /3c39e410/u);
  // An incomplete writer record keeps the hard failure.
  for (const field of ['pid', 'executablePath', 'commandline', 'startedAt']) {
    assert.equal(concurrentDesktopServiceRecord({
      realChanged: [{ path: 'x.db', why: 'mtime changed (1 -> 2)' }],
      service: { detected: true, processes: [{ ...writer, [field]: null }], at: preflightAt },
      hostLog,
    }), null, `a row missing ${field} is not a named writer`);
  }
  // A host that started after the preflight may be the arm's own child.
  assert.equal(concurrentDesktopServiceRecord({
    realChanged: [{ path: 'x.db', why: 'mtime changed (1 -> 2)' }],
    service: {
      detected: true,
      processes: [{ ...writer, startedAt: Date.parse('2026-11-10T18:14:30.000Z') }],
      at: preflightAt,
    },
    hostLog,
  }), null);
  // No detected service: the hard failure stands.
  assert.equal(concurrentDesktopServiceRecord({
    realChanged: [{ path: 'x.db', why: 'mtime changed (1 -> 2)' }],
    service: { detected: false, processes: [] },
    hostLog,
  }), null);
  // Detected, but no log line excludes the arm child: still a hard failure.
  assert.equal(concurrentDesktopServiceRecord({
    realChanged: [{ path: 'x.db', why: 'mtime changed (1 -> 2)' }],
    service: { detected: true, processes: [writer], at: preflightAt },
    hostLog: { ...hostLog, matched: [] },
  }), null);
});
