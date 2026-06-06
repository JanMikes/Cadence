import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandPalette } from "./CommandPalette";

test("CommandPalette renders nothing until opened (⌘K)", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <CommandPalette onOpenTask={() => {}} onNavigate={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toBe(""); // closed by default; ⌘K toggles it open client-side
});
