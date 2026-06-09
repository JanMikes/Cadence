import { afterEach, expect, test } from "bun:test";
import { isTauri, subscribeQuickCapture } from "./tauri";

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
