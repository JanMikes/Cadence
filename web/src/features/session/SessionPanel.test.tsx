import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPanel } from "./SessionPanel";

test("SessionPanel renders the transcript header + follow-up input", () => {
  // No WS/QueryClient needed: useServerMessages wires up in an effect (no-op in SSR).
  const html = renderToStaticMarkup(<SessionPanel sessionId="abcdef1234" onClose={() => {}} />);
  expect(html).toContain("Claude session");
  expect(html).toContain("abcdef12"); // short id
  expect(html).toContain("Send a follow-up");
  expect(html).toContain("Send");
});
