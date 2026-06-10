import { expect, test } from "bun:test";
import type { PrRef } from "@cadence/shared";
import type { CliExec } from "./forge";
import { forgeReviewApi } from "./forge-review";

const ghRef: PrRef = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  repo: "widget",
  number: 42,
  kind: "pr",
  url: "https://github.com/acme/widget/pull/42",
};
const glRef: PrRef = {
  forge: "gitlab",
  host: "gitlab.com",
  owner: "grp/sub",
  repo: "app",
  number: 7,
  kind: "mr",
  url: "https://gitlab.com/grp/sub/app/-/merge_requests/7",
};

/** Recording exec returning canned fixtures keyed by a fragment of the call. */
function fakeExec(fixtures: Array<{ match: string; out: string }>): {
  exec: CliExec;
  calls: Array<{ cmd: string; args: string[]; input?: string }>;
} {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const exec: CliExec = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const key = `${cmd} ${args.join(" ")}`;
    const hit = fixtures.find((f) => key.includes(f.match));
    if (!hit) throw new Error(`no fixture for: ${key}`);
    return hit.out;
  };
  return { exec, calls };
}

// ---------------------------------------------------------------- GitHub

test("github: meta + diff map from gh json (§6.5.b)", () => {
  const { exec, calls } = fakeExec([
    {
      match: "pr view 42",
      out: JSON.stringify({
        title: "Fix login flake",
        author: { login: "octocat" },
        state: "OPEN",
        baseRefName: "main",
        headRefName: "fix/login",
        url: ghRef.url,
        body: "Stabilizes the clock.",
        statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "success" }],
      }),
    },
    { match: "pr diff 42", out: "diff --git a/login.ts b/login.ts\n+fixed\n" },
  ]);
  const api = forgeReviewApi("github", exec);
  const meta = api.fetchMeta(ghRef);
  expect(meta.title).toBe("Fix login flake");
  expect(meta.author).toBe("octocat");
  expect(meta.state).toBe("open");
  expect(meta.baseBranch).toBe("main");
  expect(meta.headBranch).toBe("fix/login");
  expect(meta.ciStatus).toBe("success");
  expect(api.fetchDiff(ghRef)).toContain("diff --git");
  expect(calls[0]?.args).toContain("--repo");
  expect(calls[0]?.args).toContain("acme/widget");
});

test("github: threads via GraphQL map to ReviewThread (§6.5.b)", () => {
  const { exec } = fakeExec([
    {
      match: "api graphql",
      out: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "RT_1",
                    isResolved: false,
                    viewerCanResolve: true,
                    path: "login.ts",
                    line: 12,
                    comments: {
                      nodes: [
                        { author: { login: "reviewer1" }, body: "Race here?", createdAt: "2026-06-01T10:00:00Z" },
                        { author: { login: "octocat" }, body: "Looking…", createdAt: "2026-06-01T11:00:00Z" },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    },
  ]);
  const threads = forgeReviewApi("github", exec).fetchThreads(ghRef);
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({
    id: "RT_1",
    resolved: false,
    resolvable: true,
    file: "login.ts",
    line: 12,
  });
  expect(threads[0]?.comments.map((c) => c.author)).toEqual(["reviewer1", "octocat"]);
});

test("github: publishReview posts the reviews payload via stdin; resolve uses the mutation", () => {
  const { exec, calls } = fakeExec([
    { match: "pulls/42/reviews", out: JSON.stringify({ html_url: `${ghRef.url}#pullrequestreview-9` }) },
    { match: "api graphql", out: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }) },
  ]);
  const api = forgeReviewApi("github", exec);
  const r = api.publishReview(ghRef, "request_changes", "Two blockers.", [
    { file: "login.ts", line: 12, body: "This races." },
  ]);
  expect(r.url).toContain("pullrequestreview");
  const publish = calls[0];
  expect(publish?.args).toContain("repos/acme/widget/pulls/42/reviews");
  const payload = JSON.parse(publish?.input ?? "{}") as {
    event: string;
    comments: Array<{ path: string; line: number; side: string }>;
  };
  expect(payload.event).toBe("REQUEST_CHANGES");
  expect(payload.comments[0]).toMatchObject({ path: "login.ts", line: 12, side: "RIGHT" });

  expect(api.resolveThread(ghRef, "RT_1")).toBe(true);
});

// ---------------------------------------------------------------- GitLab

test("gitlab: meta, threads (system notes dropped), reply + resolve endpoints (§6.5.b)", () => {
  const { exec, calls } = fakeExec([
    {
      match: "mr view 7",
      out: JSON.stringify({
        title: "Add SSO",
        author: { username: "janmikes" },
        state: "opened",
        source_branch: "feat/sso",
        target_branch: "main",
        web_url: glRef.url,
        description: "SSO via OIDC",
        head_pipeline: { status: "failed" },
      }),
    },
    {
      match: "merge_requests/7/discussions?per_page=100",
      out: JSON.stringify([
        {
          id: "disc1",
          notes: [
            {
              author: { username: "reviewer1" },
              body: "Validate the issuer.",
              created_at: "2026-06-02T08:00:00Z",
              resolvable: true,
              resolved: false,
              position: { new_path: "sso.ts", new_line: 33 },
            },
          ],
        },
        { id: "disc2", notes: [{ system: true, body: "changed milestone" }] }, // dropped
      ]),
    },
    { match: "discussions/disc1/notes", out: "{}" },
    { match: "-X PUT projects/grp%2Fsub%2Fapp/merge_requests/7/discussions/disc1", out: "{}" },
  ]);
  const api = forgeReviewApi("gitlab", exec);

  const meta = api.fetchMeta(glRef);
  expect(meta.author).toBe("janmikes");
  expect(meta.baseBranch).toBe("main");
  expect(meta.ciStatus).toBe("failure");

  const threads = api.fetchThreads(glRef);
  expect(threads).toHaveLength(1); // the system-note discussion is dropped
  expect(threads[0]).toMatchObject({ id: "disc1", resolvable: true, file: "sso.ts", line: 33 });

  api.replyToThread(glRef, "disc1", "Fixed in abc123.");
  expect(calls.some((c) => c.args.join(" ").includes("discussions/disc1/notes"))).toBe(true);

  expect(api.resolveThread(glRef, "disc1")).toBe(true);
});

test("gitlab: publishReview posts inline discussions with diff-ref positions + the note + approve", () => {
  const { exec, calls } = fakeExec([
    {
      match: "merge_requests/7/versions",
      out: JSON.stringify([{ base_commit_sha: "b1", head_commit_sha: "h1", start_commit_sha: "s1" }]),
    },
    { match: "merge_requests/7/discussions", out: "{}" },
    { match: "merge_requests/7/notes", out: "{}" },
    { match: "mr approve 7", out: "approved" },
  ]);
  const api = forgeReviewApi("gitlab", exec);
  api.publishReview(glRef, "approve", "LGTM with one nit.", [
    { file: "sso.ts", line: 33, body: "nit: rename" },
  ]);

  const discussion = calls.find((c) => c.args.join(" ").includes("merge_requests/7/discussions") && c.args.some((a) => a.startsWith("position=")));
  expect(discussion).toBeDefined();
  const position = JSON.parse(
    (discussion?.args.find((a) => a.startsWith("position=")) ?? "position={}").slice("position=".length),
  ) as { new_path: string; base_sha: string };
  expect(position.new_path).toBe("sso.ts");
  expect(position.base_sha).toBe("b1");

  expect(calls.some((c) => c.cmd === "glab" && c.args[0] === "mr" && c.args[1] === "approve")).toBe(true);
});
