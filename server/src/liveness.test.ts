import { expect, test } from "bun:test";
import {
  isProcessAlive,
  isRunPidAlive,
  isSessionRowAlive,
  type LivenessProbe,
  parseEtime,
  probeProc,
} from "./liveness";

const DEAD_PID = 2 ** 31 - 1;

function probe(over: Partial<LivenessProbe> = {}): LivenessProbe {
  return {
    alive: () => true,
    proc: () => ({ stat: "S+", etimeSec: 5, command: "claude" }),
    now: Date.now,
    ...over,
  };
}

test("parseEtime handles mm:ss, hh:mm:ss and dd-hh:mm:ss", () => {
  expect(parseEtime("05:33")).toBe(333);
  expect(parseEtime("02:03:04")).toBe(2 * 3600 + 3 * 60 + 4);
  expect(parseEtime("1-02:03:04")).toBe(86400 + 2 * 3600 + 3 * 60 + 4);
  expect(parseEtime("0:07")).toBe(7);
  expect(parseEtime("")).toBeNull();
  expect(parseEtime("garbage")).toBeNull();
});

test("probeProc: real info for this process, null for a dead pid", () => {
  const me = probeProc(process.pid);
  expect(me).not.toBeNull();
  expect(me?.stat.toUpperCase().startsWith("Z")).toBe(false);
  expect(me?.command.length).toBeGreaterThan(0);
  expect(probeProc(DEAD_PID)).toBeNull();
});

test("isRunPidAlive: a defunct zombie is dead even though kill(0) says alive (the incident)", () => {
  const zombie = probe({ proc: () => ({ stat: "Z+", etimeSec: 99, command: "(claude)" }) });
  expect(isRunPidAlive(4242, Date.now(), zombie)).toBe(false);
});

test("isRunPidAlive: a recycled pid (start-time mismatch) is dead", () => {
  // The row says the run started 2h ago; the process behind the pid is 10s old.
  const recycled = probe({ proc: () => ({ stat: "S+", etimeSec: 10, command: "other" }) });
  expect(isRunPidAlive(4242, Date.now() - 2 * 60 * 60 * 1000, recycled)).toBe(false);
});

test("isRunPidAlive: matching signature is alive; unknown startedAt skips the signature", () => {
  const hourOld = probe({ proc: () => ({ stat: "S", etimeSec: 3600, command: "claude" }) });
  expect(isRunPidAlive(4242, Date.now() - 3600 * 1000, hourOld)).toBe(true);
  expect(isRunPidAlive(4242, null, hourOld)).toBe(true); // no signature to check
  expect(isRunPidAlive(DEAD_PID, null)).toBe(false); // real probe: gone is gone
  expect(isProcessAlive(process.pid)).toBe(true);
});

test("isSessionRowAlive: pid-less rows are alive only inside the pre-spawn grace", () => {
  const p = probe();
  expect(isSessionRowAlive({ pid: null, startedAt: Date.now() }, p)).toBe(true);
  expect(isSessionRowAlive({ pid: null, startedAt: Date.now() - 60_000 }, p)).toBe(false);
  expect(isSessionRowAlive({ pid: null, startedAt: null }, p)).toBe(false);
});
