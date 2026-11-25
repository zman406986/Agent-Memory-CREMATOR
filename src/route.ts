/**
 * The host's resolved route for the mount's asks (ADR-0028: two ask moments —
 * the entry checkpoint and the bulk prune).
 *
 * Both surviving asks go to the same place: the provider/model pair the live
 * session's own request header states. The entry ask and the prune table ask
 * read it before they compose their request; a mount with no route refuses with
 * `not-configured` instead of guessing a model.
 *
 * This module has no runtime import of the mount: it reads the host session
 * structurally (`requestHeader`), so the type cycle stays type-only and erased.
 */
import type { DshMountSession } from './plugin.js';

/** The route an ask goes to: the host's resolved provider/model pair. */
export interface JudgeRoute {
  readonly provider: string;
  readonly model: string;
}

/** The two fields a route must carry as strings. */
export type JudgeRouteField = 'provider' | 'model';

/**
 * A fixed route whose field is not a runtime string (ISSUE-427). Typed so the
 * mount can name the field in one journal line and run as if no route were
 * configured, instead of letting a malformed value reach an ask and throw.
 */
export class JudgeRouteError extends Error {
  readonly code = 'invalid-route-field';
  readonly field: JudgeRouteField;

  constructor(field: JudgeRouteField) {
    super(`the judge route's ${field} is not a string`);
    this.name = 'JudgeRouteError';
    this.field = field;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate and normalize a configured route ONCE (ISSUE-427).
 *
 * `undefined`/`null` means no fixed route (the host header decides). A field of
 * the wrong runtime type is refused by name with `JudgeRouteError`, never
 * coerced; a blank pair becomes `null`, the one "off" reading both ask lanes
 * share. Whitespace is trimmed so `" p "` and `"p"` are the same route.
 */
export function normalizeJudgeRoute(value: unknown): JudgeRoute | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new JudgeRouteError('provider');
  for (const field of ['provider', 'model'] as const) {
    if (typeof value[field] !== 'string') throw new JudgeRouteError(field);
  }
  const provider = (value['provider'] as string).trim();
  const model = (value['model'] as string).trim();
  return provider === '' || model === '' ? null : { provider, model };
}

/**
 * The host's resolved route, read from the live session's own request header,
 * or the caller's fallback pair. `null` means no ask can be made: the caller
 * refuses with `not-configured` instead of guessing a model.
 */
export function judgeRouteOf(host: DshMountSession | null | undefined,
  fallback?: JudgeRoute): JudgeRoute | null {
  if (fallback !== undefined) return normalizeJudgeRoute(fallback);
  const header = typeof host?.requestHeader === 'function' ? host.requestHeader() : undefined;
  const config = isRecord(header) && isRecord(header['config']) ? header['config'] : null;
  if (config === null) return null;
  const provider = typeof config['provider'] === 'string' ? config['provider'] : null;
  const model = typeof config['model'] === 'string' ? config['model'] : null;
  return provider === null || model === null || provider.trim() === '' || model.trim() === ''
    ? null : { provider: provider.trim(), model: model.trim() };
}
