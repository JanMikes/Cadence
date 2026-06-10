import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { _resetToasts, dismissToast, getToasts, toast, Toaster } from "./Toaster";

afterEach(() => _resetToasts());

test("Toaster renders nothing when there are no toasts", () => {
  expect(renderToStaticMarkup(<Toaster />)).toBe("");
});

test("toast() shows a dismissible message", () => {
  toast("🎉 “Fix the thing” merged — task done. Nice ship!");
  const html = renderToStaticMarkup(<Toaster />);
  expect(html).toContain("merged — task done");
  expect(html).toContain("Dismiss");
});

test("dismissToast removes just that toast", () => {
  toast("toast-alpha");
  toast("toast-beta");
  const [first] = getToasts();
  dismissToast(first?.id ?? "");
  const html = renderToStaticMarkup(<Toaster />);
  expect(html).not.toContain("toast-alpha");
  expect(html).toContain("toast-beta");
});

test("toasts cap at the 3 most recent", () => {
  toast("t1");
  toast("t2");
  toast("t3");
  toast("t4");
  const html = renderToStaticMarkup(<Toaster />);
  expect(html).not.toContain("t1");
  expect(html).toContain("t2");
  expect(html).toContain("t4");
});
