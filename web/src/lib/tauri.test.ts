import { afterEach, expect, test } from "bun:test";
import { getAutostart, isTauri, setAutostart, subscribeQuickCapture } from "./tauri";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("subscribeQuickCapture is inert in a plain browser (no __TAURI__)", async () => {
  let called = false;
  const unlisten = await subscribeQuickCapture(() => {
    called = true;
  });
  expect(unlisten).toBeNull();
  expect(called).toBe(false);
  expect(isTauri()).toBe(false);
});

test("subscribeQuickCapture opens quick-capture when a mocked native event fires", async () => {
  const handlers: Array<(e: unknown) => void> = [];
  const unlistenSpy = () => {};
  (globalThis as { window?: unknown }).window = {
    __TAURI__: {
      event: {
        listen: (event: string, handler: (e: unknown) => void) => {
          if (event === "quick-capture") handlers.push(handler);
          return Promise.resolve(unlistenSpy);
        },
      },
    },
  };
  expect(isTauri()).toBe(true);

  let opened = 0;
  const unlisten = await subscribeQuickCapture(() => {
    opened += 1;
  });
  expect(unlisten).toBe(unlistenSpy);
  expect(handlers).toHaveLength(1);

  // simulate the native global hotkey firing the event
  for (const handler of handlers) handler({});
  expect(opened).toBe(1);
});

test("autostart bridge is inert in a plain browser (no __TAURI__)", async () => {
  expect(await getAutostart()).toBeNull();
  expect(await setAutostart(true)).toBe(false);
});

test("autostart bridge calls the plugin commands inside the Tauri shell", async () => {
  const calls: string[] = [];
  (globalThis as { window?: unknown }).window = {
    __TAURI__: {
      core: {
        invoke: (cmd: string) => {
          calls.push(cmd);
          return Promise.resolve(cmd === "plugin:autostart|is_enabled" ? true : undefined);
        },
      },
    },
  };
  expect(await getAutostart()).toBe(true);
  expect(await setAutostart(true)).toBe(true);
  expect(await setAutostart(false)).toBe(true);
  expect(calls).toEqual([
    "plugin:autostart|is_enabled",
    "plugin:autostart|enable",
    "plugin:autostart|disable",
  ]);
});
