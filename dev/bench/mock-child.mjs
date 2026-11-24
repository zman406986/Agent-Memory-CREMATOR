#!/usr/bin/env node
/**
 * Race-safe child-process helpers for the loopback mock tests.
 *
 * A mock that dies before writing its port file is the known loopback-bind
 * `EADDRNOTAVAIL` flake. Waiting out the startup deadline hides it; awaiting
 * `close` after `kill()` when the event already fired hangs the suite forever.
 * ISSUE-504 introduced these helpers in `opencode-run.test.mjs`; ISSUE-505 moved
 * them here so `opencode-reasoning.test.mjs` uses the same guarded pattern.
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * The mock's port, or a fast rejection when the child dies first. The mock
 * writes its port file only after `listen()` succeeds, so a bind failure leaves
 * no file; the rejection names the child's exit state and stderr.
 */
export async function waitForMockPort(child, portFile, timeoutMs = 15_000) {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(portFile)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      // Let the pipe deliver the child's last stderr line before it is reported.
      await new Promise((done) => setTimeout(done, 100));
      throw new Error('the mock exited before writing its port file '
        + `(code ${String(child.exitCode)}, signal ${String(child.signalCode)}): `
        + stderr.trim());
    }
    if (Date.now() > deadline) {
      throw new Error(`the mock did not start within ${String(timeoutMs)}ms: ${stderr.trim()}`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  return Number(readFileSync(portFile, 'utf8').trim());
}

/**
 * Stops a mock child and always settles. A child that already exited has no
 * future `close` event, so awaiting one after `kill()` (with the listener
 * attached too late) is the suite hang this helper removes. The deadline is a
 * backstop for a child whose stdio never closes, not a pass/fail assertion.
 */
export function stopMock(child, timeoutMs = 5_000) {
  if (child === null || child === undefined) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((settled) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settled();
    }, timeoutMs);
    timer.unref?.();
    child.once('close', () => {
      clearTimeout(timer);
      settled();
    });
    child.kill();
  });
}

/** Rejects when `promise` has not settled inside `ms`; clears its timer on settle. */
export async function settlesWithin(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
