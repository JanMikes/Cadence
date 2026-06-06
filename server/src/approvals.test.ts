import { expect, test } from "bun:test";
import { type ApprovalEvent, ApprovalRegistry } from "./approvals";

test("request parks until resolve, then the promise yields the decision", async () => {
  const reg = new ApprovalRegistry();
  const p = reg.request({ toolName: "Bash", input: { command: "rm -rf /" } }, { id: "a1" });
  // parked + visible in the list
  expect(reg.list().map((r) => r.id)).toEqual(["a1"]);
  expect(reg.list()[0]?.toolName).toBe("Bash");

  expect(reg.resolve("a1", { allow: false, reason: "too risky" })).toBe(true);
  await expect(p).resolves.toEqual({ allow: false, reason: "too risky" });
  expect(reg.list()).toHaveLength(0); // cleared
});

test("resolve is idempotent / safe on an unknown id", () => {
  const reg = new ApprovalRegistry();
  expect(reg.resolve("nope", { allow: true })).toBe(false);
});

test("onChange fires requested then resolved", async () => {
  const events: Array<[string, ApprovalEvent]> = [];
  const reg = new ApprovalRegistry((req, event) => events.push([req.id, event]));
  const p = reg.request({ toolName: "Write" }, { id: "x" });
  reg.resolve("x", { allow: true });
  await p;
  expect(events).toEqual([
    ["x", "requested"],
    ["x", "resolved"],
  ]);
});

test("canUseTool binds a context and routes through the registry", async () => {
  const reg = new ApprovalRegistry();
  const cb = reg.canUseTool({ sessionId: "s1", taskId: "t1" });
  const decision = cb("Edit", { file: "a.ts" });
  const parked = reg.list()[0];
  expect(parked?.sessionId).toBe("s1");
  expect(parked?.taskId).toBe("t1");
  expect(parked?.toolName).toBe("Edit");
  reg.resolve(parked?.id as string, { allow: true });
  await expect(decision).resolves.toEqual({ allow: true });
});
