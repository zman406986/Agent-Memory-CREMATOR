/**
 * The depth trigger (ISSUE-022 chunk 6; ADR-0050 decisions 1–3). Harness-
 * agnostic and pure: the mount owns the reading and what a fire schedules;
 * this module owns WHEN an automatic prune ask fires.
 *
 * The bar is an absolute token count when the mount configures one
 * (`pruneThresholdTokens`; the product's test value is 60 000). An explicit bar
 * wins over the host window, and it arms the latch on its own: the latch needs
 * no window to arm at a depth the mount owns.
 *
 * If only a window is configured, the trigger falls back to one-half of it
 * (ADR-0009 §Amendment 2026-10-24). That is the deprecated compatibility path
 * ADR-0050 decision 2 keeps for old launch rows, never the product rule.
 *
 * WHICH reading the mount feeds is the mount's decision (ISSUE-092): dsh feeds
 * the host's billed prompt for the last accounted request, one step stale, and
 * falls back to the local whole-request estimate only before the first usage
 * row. The local estimate counted message text only, so on live runs it read
 * ~0.56 of the host meter and a 200 000 bar never armed. The opencode adapter
 * feeds the same kind of reading from its reconciliation meter.
 *
 * The re-arm policy (CRITIC-022 P1-1, provisional 2026-10-24, PM-ruled;
 * restated in bars by ADR-0050 decision 3):
 *
 *   (a) after ANY pass completes — manual or auto-fired — the latch re-arms; a
 *       pass that throws re-arms too, so one failure never disables auto-prune
 *       for the rest of the session;
 *   (b) an observation fires when usage is at or above the bar AND either usage
 *       has been below the bar since the last fire (a crossing), or it has grown
 *       by at least one re-arm delta since the baseline the last pass left. The
 *       delta is the explicit bar when one is configured, else half the window.
 *       The baseline after a pass is the pass's own post-removal reading — the
 *       first observation after it (ADR-0050 Amendment 2026-11-18): a pass at
 *       254 000 that removes 40 000 re-fires at 274 000, not 314 000;
 *   (c) a native host compaction is an external reset: it re-arms the latch as
 *       if a pass had completed, so a session the host compacted is pruned by
 *       the next crossing instead of waiting out a growth delta that the
 *       compaction already invalidated (the ISSUE-022 DoD backstop);
 *   (d) no automatic fire at or above 75% of the host window (ADR-0050
 *       Amendment 2026-11-18, second): native compaction is imminent there, so
 *       an ask would buy a few turns and cost one. The host compacts and (c)
 *       re-arms from its surface. A manual pass is not the automatic trigger
 *       and is not affected.
 *
 * The old rule re-armed only below the line, so a single pass (or one throw)
 * left the session above half and the latch closed for good.
 *
 * Pure and session-local: it holds numbers, takes numbers, returns a boolean.
 */
export function resolveContextWindowTokens(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('cremator: contextWindowTokens must be null or a positive safe integer');
  }
  return value;
}

/**
 * The absolute prune bar as the mount resolves it (ADR-0050 decision 2):
 * absent or null means "no explicit bar" and the window path decides; anything
 * else must be a positive safe integer. Same shape as the window validator, so
 * the config resolver and the latch cannot disagree about what a bar is.
 */
export function resolvePruneThresholdTokens(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('cremator: pruneThresholdTokens must be null or a positive safe integer');
  }
  return value;
}

/**
 * The latch's whole session-local state (ISSUE-336), in the plain shape a
 * mount persists beside the session's ledger and reads back on a remount.
 * The trigger stays pure: it exports and accepts the numbers; the mount owns
 * the file they live in.
 */
export interface PruneWindowTriggerState {
  readonly lastFireUsage: number | null;
  readonly belowSinceFire: boolean;
  readonly baselinePending: boolean;
}

/**
 * One session's crossing latch. With neither an explicit bar nor a window the
 * feature is off (the mount stays record-only — ADR-0008's rollout order), and
 * every observation answers false. An explicit `thresholdTokens` arms the
 * latch on its own; `windowTokens` is then only the deprecated fallback.
 */
export class PruneWindowTrigger {
  /**
   * The host window the 75% skip line and the deprecated half-window bar read.
   * Mutable because a mount may resolve it from the routed model after the
   * session opened (ADR-0071): the constructor value is the configured window,
   * and a null one can become a resolved number at a later boundary.
   */
  private windowTokens: number | null;
  private readonly thresholdTokens: number | null;
  /**
   * The baseline: the usage at the last fire, or the first observation after
   * the last pass (its post-removal reading). Null when none is known.
   */
  private lastFireUsage: number | null = null;
  /** True once usage was observed below the line since that baseline. */
  private belowSinceFire = false;
  /**
   * True after a pass: the next observation is the pass's post-removal reading
   * and becomes the baseline without firing (ADR-0050 Amendment 2026-11-18).
   */
  private baselinePending = false;

  constructor(windowTokens: number | null, thresholdTokens?: number | null) {
    this.windowTokens = resolveContextWindowTokens(windowTokens);
    this.thresholdTokens = resolvePruneThresholdTokens(thresholdTokens);
  }

  /**
   * Replace the host window after the mount resolved the routed model's
   * capacity (ADR-0071). The latch state is unchanged: the caller decides
   * whether the new window is a cold boundary and re-arms separately. A null
   * value disables the window-derived path; an explicit bar still wins.
   * @param windowTokens - the exact route's positive window, or null when unknown.
   */
  setWindowTokens(windowTokens: number | null): void {
    this.windowTokens = resolveContextWindowTokens(windowTokens);
  }

  /**
   * The routed model changed, so the latch's baseline describes another model
   * (ADR-0072). Re-arm as a completed pass does: the next observation becomes
   * the baseline and does not fire. Unlike {@link notePassCompleted} this runs
   * even while the window is unknown, so a later resolution starts from the
   * switch rather than from a stale baseline.
   */
  noteColdBoundary(): void {
    this.lastFireUsage = null;
    this.belowSinceFire = false;
    this.baselinePending = true;
  }

  /** True when a configured bar (explicit or window-derived) arms the latch. */
  get enabled(): boolean {
    return this.threshold !== null;
  }

  /**
   * The token count a crossing is measured against. An explicit bar wins; with
   * none, half the window is the deprecated compatibility path; with neither,
   * the trigger is off.
   */
  get threshold(): number | null {
    if (this.thresholdTokens !== null) return this.thresholdTokens;
    return this.windowTokens === null ? null : this.windowTokens / 2;
  }

  /**
   * The depth at or above which the automatic ask is skipped (ADR-0050
   * Amendment 2026-11-18, second): 75% of the host window, rounded UP so the
   * line is always an integer reading. A fractional line (333,333 × 0.75 =
   * 249,999.75) cannot be journaled as a token count; the bench's safe-integer
   * reader records it as `null`, losing the skip line from the record. The
   * ceiling is the first integer at or above 75%. Native compaction is imminent
   * there, so the ask would buy a few turns and cost one; the host compacts and
   * this latch re-arms from the compacted surface. No window means no skip.
   */
  get skipThreshold(): number | null {
    return this.windowTokens === null ? null : Math.ceil(this.windowTokens * 0.75);
  }

  /**
   * The growth after the last fire that re-fires the latch: the explicit bar
   * when one is configured, else half the window. It is the same number as
   * `threshold` on both paths today; it stays a named rule because ADR-0050
   * states re-arm in bars, not in crossings.
   */
  private get rearmDelta(): number | null {
    if (this.thresholdTokens !== null) return this.thresholdTokens;
    return this.windowTokens === null ? null : this.windowTokens / 2;
  }

  /**
   * Records one observation and answers whether THIS observation fires.
   *
   * The first observation after a pass never fires: it IS the pass's
   * post-removal reading and becomes the baseline (ADR-0050 Amendment
   * 2026-11-18) — even when it lands at or above the 75% skip line, because
   * the skip is a fire guard, not a new bar (ISSUE-366). Below the bar, later
   * observations only mark the excursion (a later crossing fires). At or above
   * the bar, a fire needs either that excursion, no baseline at all (the
   * session's first crossing), or one re-arm delta of growth since the
   * baseline. A fire moves the baseline to this observation. At or above 75%
   * of the host window nothing fires: the host's compaction is imminent, so
   * the ask would be wasted (ADR-0050 Amendment 2026-11-18, second).
   */
  observe(estimatedTokens: number): boolean {
    const threshold = this.threshold;
    if (threshold === null) return false;
    if (this.baselinePending) {
      this.baselinePending = false;
      this.lastFireUsage = estimatedTokens;
      this.belowSinceFire = estimatedTokens < threshold;
      return false;
    }
    const skipAt = this.skipThreshold;
    if (skipAt !== null && estimatedTokens >= skipAt) return false;
    if (estimatedTokens < threshold) {
      this.belowSinceFire = true;
      return false;
    }
    const delta = this.rearmDelta;
    const grew = this.lastFireUsage !== null && delta !== null
      && estimatedTokens >= this.lastFireUsage + delta;
    if (!this.belowSinceFire && this.lastFireUsage !== null && !grew) return false;
    this.belowSinceFire = false;
    this.lastFireUsage = estimatedTokens;
    return true;
  }

  /**
   * One pass completed — manual or auto, applied or refused, or it threw. The
   * next observation is the pass's post-removal reading and becomes the
   * baseline; the next fire needs one re-arm delta of NEW growth above it, or
   * a below-bar excursion (ADR-0050 Amendment 2026-11-18). A pass that refused
   * or threw leaves the surface unchanged, so the same rule holds: the next
   * reading describes what is actually in the context now.
   */
  notePassCompleted(): void {
    if (this.threshold === null) return;
    this.baselinePending = true;
  }

  /**
   * A crossing reached the mount, but no pass could run — the adapter held no
   * unit an already-sent request had carried (the eligibility rule), so it had
   * nothing to table. The crossing is NOT consumed: the fire baseline is
   * cleared so the next above-bar observation fires, while a below-bar
   * excursion already seen stays seen. Without this, a first request that
   * crosses the bar before any result has been sent spends the crossing and
   * the next ask needs a full bar of new growth (ISSUE-300 item 11).
   *
   * A pass that DID run and found every unit settled, or whose ask was sent and
   * failed, must call `notePassCompleted` instead: the pass read the surface and
   * the next reading is its post-removal baseline.
   */
  notePassSkipped(): void {
    if (this.threshold === null) return;
    this.lastFireUsage = null;
  }

  /**
   * A native host compaction ended (`compaction/end` on dsh,
   * `session.compaction.ended` on opencode). The host rewrote the surface on
   * its own, so the old baseline no longer describes this session: re-arm as a
   * fresh latch and let the next observation fire. This is the ISSUE-022 DoD
   * backstop — native compaction is observed, never suppressed by this module.
   */
  noteNativeCompaction(): void {
    if (this.threshold === null) return;
    this.baselinePending = false;
    this.lastFireUsage = null;
    this.belowSinceFire = false;
  }

  /**
   * The state a remount restores (ISSUE-336): the baseline, the excursion mark
   * and the pending post-pass baseline. Plain numbers, no I/O — the mount
   * writes them beside the session's ledger and reads them back on restart.
   */
  snapshot(): PruneWindowTriggerState {
    return {
      lastFireUsage: this.lastFireUsage,
      belowSinceFire: this.belowSinceFire,
      baselinePending: this.baselinePending,
    };
  }

  /**
   * Rehydrate a persisted snapshot (ISSUE-336), so the first above-bar
   * observation after a restart does not immediately re-ask just-judged units.
   * A malformed state is refused by name; a store reads fail-open and never
   * hands garbage here.
   */
  restore(state: PruneWindowTriggerState): void {
    const { lastFireUsage, belowSinceFire, baselinePending } = state;
    if (lastFireUsage !== null
      && (typeof lastFireUsage !== 'number' || !Number.isSafeInteger(lastFireUsage)
        || lastFireUsage < 0)) {
      throw new Error(
        'cremator: trigger state lastFireUsage must be null or a non-negative safe integer');
    }
    if (typeof belowSinceFire !== 'boolean') {
      throw new Error('cremator: trigger state belowSinceFire must be a boolean');
    }
    if (typeof baselinePending !== 'boolean') {
      throw new Error('cremator: trigger state baselinePending must be a boolean');
    }
    this.lastFireUsage = lastFireUsage;
    this.belowSinceFire = belowSinceFire;
    this.baselinePending = baselinePending;
  }
}
