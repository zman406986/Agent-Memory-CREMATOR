import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ForkError, appendAsk, appendMessage, appendVerdict, seedFork, wireRequestHash,
} from "../src/judge/fork.js";
import type { ForkErrorCode, WireFork, WireRequest, WireTool } from "../src/judge/fork.js";

const SYSTEM = "You are the verdict judge. Decide one tool result.";
const VERDICT = '{"keepall":true}';

function tool(name: string, description = `${name} tool`): WireTool {
  return { name, description, parameters: { type: "object", properties: {} } };
}

/** Main's last sent request: the same fields the fork copies, nothing more. */
function request(): WireRequest {
  return {
    system: SYSTEM,
    tools: [tool("forget"), tool("recall")],
    messages: [
      { role: "user", text: "Read src/example.ts" },
      { role: "assistant", text: "Reading it now." },
      { role: "tool", text: "line one\nline two" },
    ],
  };
}

/** A fork whose last message is an assistant turn: a verdict may follow. */
function seeded(): WireFork {
  const sent = request();
  return seedFork({
    ...sent,
    messages: [...sent.messages, { role: "assistant", text: "The tool answered." }],
  });
}

/** A fork whose last message is the user's turn: the corner that stalled the pass. */
function seededOnUser(): WireFork {
  const sent = request();
  return seedFork({
    ...sent,
    messages: [...sent.messages, { role: "user", text: "one more thing" }],
  });
}

function forkError(code: ForkErrorCode): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ForkError && error.code === code;
}

/**
 * A copy that hashes as one text but copies as another: a Proxy stand-in for a
 * re-render, the seed's one guarantee failing live.
 */
function drifting(): WireRequest {
  const target = [{ role: "user" as const, text: "sent" }];
  const messages = new Proxy(target, {
    get(object, property, receiver) {
      if (property === "0") return { role: "user" as const, text: "re-rendered" };
      return Reflect.get(object, property, receiver);
    },
  });
  return { system: SYSTEM, tools: [], messages };
}

/**
 * Every refusal an append can raise: each row breaks one claim of a fork that
 * otherwise appends, so a check that stopped reading would let the row through.
 */
const APPEND_DEFECTS: readonly {
  readonly row: string;
  readonly code: ForkErrorCode;
  readonly run: (seed: WireFork) => unknown;
}[] = [
  {
    row: "an earlier message rewritten after the seed",
    code: "message-hash-drift",
    run: seed => {
      const asked = appendAsk(seed, "Judge this unit.");
      (asked.messages[0] as { text: string }).text = "mutated after seeding";
      return appendVerdict(asked, VERDICT);
    },
  },
  {
    row: "a system grown by one extra word",
    code: "system-hash-drift",
    run: seed => appendVerdict({ ...seed, system: `${seed.system} extra` }, VERDICT),
  },
  {
    row: "a tool list grown by one extra tool",
    code: "tools-hash-drift",
    run: seed => appendVerdict({ ...seed, tools: [...seed.tools, tool("expand")] }, VERDICT),
  },
  {
    row: "a second assistant turn through appendVerdict",
    code: "role-conflict",
    run: seed => appendVerdict(seed, VERDICT),
  },
  {
    row: "a second assistant turn through appendMessage",
    code: "role-conflict",
    run: seed => appendMessage(seed, { role: "assistant", text: "second answer" }),
  },
];

test("a defective fork is refused with its own typed code, and the refusal changes nothing", () => {
  for (const { row, code, run } of APPEND_DEFECTS) {
    const seed = seeded();
    const before = [...seed.messageHashes];
    assert.throws(() => run(seed), forkError(code), `row: ${row} — expected ${code}`);
    assert.equal(seed.messages.length, 4, `row: ${row} — a refusal appends nothing`);
    assert.deepEqual(seed.messageHashes, before, `row: ${row} — a refusal rewrites no prefix hash`);
    assert.equal(seed.messages[0]?.text, "Read src/example.ts",
      `row: ${row} — the defect must not reach the seed fork`);
    assert.equal(appendAsk(seed, "probe").messages.length, 5,
      `row: ${row} — the seed fork still appends after the refusal`);
  }
  assert.throws(() => seedFork(drifting()), forkError("seed-hash-mismatch"),
    "row: a copy that re-renders one message — expected seed-hash-mismatch");
});

test("the seed is a frozen copy of the sent request, and its recorded hashes are the immutable prefix", () => {
  const sent = request();
  const fork = seedFork(sent);
  assert.equal(fork.seedHash, wireRequestHash(sent),
    "row: seed-hash — the fork hashes to main's last sent request");
  assert.equal(wireRequestHash(fork), wireRequestHash(sent),
    "row: seed-hash — the fork's own wire state hashes the same");
  assert.equal(seedFork(request()).seedHash, fork.seedHash,
    "row: seed-hash — two seeds of equal wire state agree");

  assert.deepEqual(fork.system, sent.system, "row: copy — the system bytes come back equal");
  assert.deepEqual(fork.tools, sent.tools, "row: copy — the tool list comes back equal");
  assert.deepEqual(fork.messages, sent.messages, "row: copy — the message list comes back equal");
  assert.notEqual(fork.tools[0], sent.tools[0],
    "row: copy — the tool records are new objects, not the caller's");
  assert.notEqual(fork.messages[0], sent.messages[0],
    "row: copy — the message records are new objects, not the caller's");

  assert.equal(Object.isFrozen(fork), true, "row: freeze — the fork itself is frozen");
  assert.throws(() => { (fork as { system: string }).system = "replaced"; }, TypeError,
    "row: freeze — a frozen system message rejects assignment");
  assert.equal(fork.system, SYSTEM, "row: freeze — the refused assignment changed nothing");
  const firstTool = fork.tools[0];
  assert.ok(firstTool !== undefined, "row: freeze — the fork carried its first tool");
  assert.equal(Object.isFrozen(firstTool.parameters), true,
    "row: freeze — the tool records are frozen through their nested objects");
  assert.throws(() => { (firstTool as { description: string }).description = "replaced"; }, TypeError,
    "row: freeze — a frozen tool record rejects assignment");

  const seed = seeded();
  const before = { seedHash: seed.seedHash, systemHash: seed.systemHash,
    toolsHash: seed.toolsHash, messageHashes: [...seed.messageHashes] };
  const asked = appendAsk(seed, "Judge this unit.");
  const answered = appendVerdict(asked, VERDICT);
  const again = appendAsk(answered, "Judge the next unit.");
  const grown: readonly (readonly [string, number, WireFork])[] = [
    ["ask", 1, asked], ["verdict", 2, answered], ["re-ask", 3, again],
  ];
  for (const [step, appends, child] of grown) {
    assert.equal(child.seedHash, before.seedHash, `row: ${step} — the seed hash drifted`);
    assert.equal(child.systemHash, before.systemHash, `row: ${step} — the system hash drifted`);
    assert.equal(child.toolsHash, before.toolsHash, `row: ${step} — the tools hash drifted`);
    assert.deepEqual(child.messageHashes.slice(0, before.messageHashes.length),
      before.messageHashes, `row: ${step} — a prefix message hash drifted`);
    assert.equal(child.messages.length, seed.messages.length + appends,
      `row: ${step} — growth is one message per append`);
  }
  assert.equal(seed.messages.length, 4, "row: append-only — the seed holds four messages");
  assert.deepEqual(asked.messages.slice(0, seed.messages.length), seed.messages,
    "row: append-only — a grown fork extends its seed unchanged");
  assert.equal(asked.messages[asked.messages.length - 1]?.text, "Judge this unit.",
    "row: append-only — the ask is the last message");
  assert.equal(answered.messages[answered.messages.length - 1]?.role, "assistant",
    "row: append-only — the verdict is the last message");
  assert.equal(wireRequestHash(asked) === seed.seedHash, false,
    "row: append-only — a grown fork covers more bytes than its seed");
});

/** The legal growths: the role rule refuses only a second non-user turn in a row. */
const LEGAL_GROWTH: readonly {
  readonly row: string;
  readonly seed: "assistant" | "user";
  readonly steps: readonly ("ask" | "verdict" | "userMessage")[];
}[] = [
  { row: "an ask after the user's last turn", seed: "user", steps: ["ask", "verdict", "ask"] },
  { row: "a second ask with no answer between", seed: "assistant", steps: ["ask", "ask"] },
  { row: "a user message after a user ask", seed: "assistant", steps: ["ask", "userMessage"] },
  { row: "a verdict after an ask that follows a verdict", seed: "assistant",
    steps: ["ask", "verdict", "ask", "verdict"] },
];

const STEP_ROLE = { ask: "user", verdict: "assistant", userMessage: "user" } as const;

function grow(fork: WireFork, step: keyof typeof STEP_ROLE): WireFork {
  if (step === "ask") return appendAsk(fork, "Judge this unit.");
  if (step === "verdict") return appendVerdict(fork, VERDICT);
  return appendMessage(fork, { role: "user", text: "same role" });
}

test("user after user is legal: the judge ask appends whatever the seed's last turn was", () => {
  for (const { row, seed: kind, steps } of LEGAL_GROWTH) {
    const seed = kind === "user" ? seededOnUser() : seeded();
    const seedLength = seed.messages.length;
    let current = seed;
    for (const [index, step] of steps.entries()) {
      // A legal growth must APPEND; a refusal is a failure that names its row,
      // never the fork's own error text standing in for a row.
      let next: WireFork;
      try {
        next = grow(current, step);
      } catch (error) {
        assert.fail(`row: ${row} — step ${index} (${step}) was refused: `
          + (error instanceof Error ? error.message : String(error)));
      }
      assert.equal(next.messages.length, current.messages.length + 1,
        `row: ${row} — step ${index} (${step}) appends exactly one message`);
      assert.equal(next.messages[next.messages.length - 1]?.role, STEP_ROLE[step],
        `row: ${row} — step ${index} (${step}) appends its own role`);
      current = next;
    }
    assert.equal(seed.messages.length, seedLength, `row: ${row} — the seed fork is untouched`);
    assert.equal(seedLength, 4, `row: ${row} — the seed keeps main's four messages`);
  }
});
