import type {
  PrRef,
  ReviewDraftComment,
  ReviewMeta,
  ReviewThread,
  ReviewVerdict,
} from "@cadence/shared";
import { type CliExec, forgeCliExec } from "./forge";

/**
 * Forge review data layer (plan §6.5.b) — one interface, two CLI-backed
 * implementations (gh / glab). Everything goes through the injectable exec seam so
 * tests run against recorded fixtures; the real-API smoke is the human acceptance
 * step (6.5.i). ⚠ glab flags and both REST/GraphQL payload shapes are doc-verified,
 * not live-run.
 */
export interface ForgeReviewApi {
  fetchMeta(ref: PrRef): ReviewMeta;
  fetchDiff(ref: PrRef): string;
  fetchThreads(ref: PrRef): ReviewThread[];
  /** Publish a review: verdict + summary + inline comments. Returns the review/PR url when known. */
  publishReview(
    ref: PrRef,
    verdict: ReviewVerdict,
    summary: string,
    comments: ReviewDraftComment[],
  ): { url: string | null };
  replyToThread(ref: PrRef, threadId: string, body: string): void;
  /** Resolve a thread. Returns false when the forge/thread doesn't support it. */
  resolveThread(ref: PrRef, threadId: string): boolean;
}

export function forgeReviewApi(forge: PrRef["forge"], exec: CliExec = forgeCliExec): ForgeReviewApi {
  return forge === "github" ? githubApi(exec) : gitlabApi(exec);
}

const repoOf = (ref: PrRef): string => `${ref.owner}/${ref.repo}`;

// ---------------------------------------------------------------- GitHub (gh)

function githubApi(exec: CliExec): ForgeReviewApi {
  return {
    fetchMeta(ref) {
      const out = exec("gh", [
        "pr",
        "view",
        String(ref.number),
        "--repo",
        repoOf(ref),
        "--json",
        "title,author,state,baseRefName,headRefName,url,body,statusCheckRollup",
      ]);
      const j = JSON.parse(out) as {
        title?: string;
        author?: { login?: string };
        state?: string;
        baseRefName?: string;
        headRefName?: string;
        url?: string;
        body?: string;
        statusCheckRollup?: Array<{ conclusion?: string; status?: string }>;
      };
      return {
        title: j.title ?? "",
        author: j.author?.login ?? null,
        state: (j.state ?? "").toLowerCase(),
        baseBranch: j.baseRefName ?? null,
        headBranch: j.headRefName ?? null,
        url: j.url ?? ref.url,
        body: j.body ?? "",
        ciStatus: rollupCi(j.statusCheckRollup),
      };
    },

    fetchDiff(ref) {
      return exec("gh", ["pr", "diff", String(ref.number), "--repo", repoOf(ref)]);
    },

    fetchThreads(ref) {
      // Thread grouping + resolution state only exist in the GraphQL API. ⚠
      const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved viewerCanResolve path line comments(first:50){nodes{author{login} body createdAt}}}}}}}`;
      const out = exec("gh", [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${ref.owner}`,
        "-F",
        `repo=${ref.repo}`,
        "-F",
        `number=${ref.number}`,
      ]);
      const j = JSON.parse(out) as {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: Array<{
                  id?: string;
                  isResolved?: boolean;
                  viewerCanResolve?: boolean;
                  path?: string | null;
                  line?: number | null;
                  comments?: { nodes?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }> };
                }>;
              };
            };
          };
        };
      };
      const nodes = j.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      return nodes.map((n) => ({
        id: n.id ?? "",
        resolved: n.isResolved === true,
        resolvable: n.viewerCanResolve === true,
        file: n.path ?? null,
        line: n.line ?? null,
        comments: (n.comments?.nodes ?? []).map((c) => ({
          author: c.author?.login ?? null,
          body: c.body ?? "",
          createdAt: c.createdAt ?? null,
        })),
      }));
    },

    publishReview(ref, verdict, summary, comments) {
      const event =
        verdict === "approve" ? "APPROVE" : verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
      const payload = JSON.stringify({
        body: summary,
        event,
        comments: comments.map((c) => ({ path: c.file, line: c.line, side: "RIGHT", body: c.body })),
      });
      const out = exec(
        "gh",
        ["api", `repos/${repoOf(ref)}/pulls/${ref.number}/reviews`, "--input", "-"],
        payload,
      );
      try {
        const j = JSON.parse(out) as { html_url?: string };
        return { url: j.html_url ?? null };
      } catch {
        return { url: null };
      }
    },

    replyToThread(_ref, threadId, body) {
      // Reply via GraphQL so the comment lands IN the thread (REST replies need a
      // numeric comment id; our thread ids are GraphQL node ids). ⚠
      const mutation = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}`;
      exec("gh", ["api", "graphql", "-f", `query=${mutation}`, "-F", `threadId=${threadId}`, "-F", `body=${body}`]);
    },

    resolveThread(_ref, threadId) {
      const mutation = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}`;
      try {
        const out = exec("gh", ["api", "graphql", "-f", `query=${mutation}`, "-F", `threadId=${threadId}`]);
        const j = JSON.parse(out) as {
          data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } };
        };
        return j.data?.resolveReviewThread?.thread?.isResolved === true;
      } catch {
        return false;
      }
    },
  };
}

function rollupCi(rollup: Array<{ conclusion?: string; status?: string }> | undefined): string | null {
  if (!rollup?.length) return null;
  const conclusions = rollup.map((r) => (r.conclusion ?? r.status ?? "").toLowerCase());
  if (conclusions.some((c) => ["failure", "error", "timed_out", "cancelled"].includes(c))) return "failure";
  if (conclusions.some((c) => ["pending", "in_progress", "queued", ""].includes(c))) return "pending";
  return "success";
}

// ---------------------------------------------------------------- GitLab (glab)

/** GitLab addresses projects by URL-encoded full path. */
const glProject = (ref: PrRef): string => encodeURIComponent(`${ref.owner}/${ref.repo}`);

function gitlabApi(exec: CliExec): ForgeReviewApi {
  return {
    fetchMeta(ref) {
      const out = exec("glab", ["mr", "view", String(ref.number), "--repo", repoOf(ref), "--output", "json"]);
      const j = JSON.parse(out) as {
        title?: string;
        author?: { username?: string };
        state?: string;
        source_branch?: string;
        target_branch?: string;
        web_url?: string;
        description?: string;
        head_pipeline?: { status?: string } | null;
      };
      const pipeline = (j.head_pipeline?.status ?? "").toLowerCase();
      return {
        title: j.title ?? "",
        author: j.author?.username ?? null,
        state: (j.state ?? "").toLowerCase(),
        baseBranch: j.target_branch ?? null,
        headBranch: j.source_branch ?? null,
        url: j.web_url ?? ref.url,
        body: j.description ?? "",
        ciStatus: pipeline
          ? ["failed", "canceled"].includes(pipeline)
            ? "failure"
            : pipeline === "success"
              ? "success"
              : "pending"
          : null,
      };
    },

    fetchDiff(ref) {
      return exec("glab", ["mr", "diff", String(ref.number), "--repo", repoOf(ref)]);
    },

    fetchThreads(ref) {
      const out = exec("glab", [
        "api",
        `projects/${glProject(ref)}/merge_requests/${ref.number}/discussions?per_page=100`,
      ]);
      const discussions = JSON.parse(out) as Array<{
        id?: string;
        notes?: Array<{
          author?: { username?: string };
          body?: string;
          created_at?: string;
          system?: boolean;
          resolvable?: boolean;
          resolved?: boolean;
          position?: { new_path?: string | null; new_line?: number | null } | null;
        }>;
      }>;
      return discussions
        .map((d) => {
          const notes = (d.notes ?? []).filter((n) => !n.system);
          const first = notes[0];
          if (!first) return null;
          return {
            id: d.id ?? "",
            resolved: notes.every((n) => n.resolved !== false || !n.resolvable),
            resolvable: notes.some((n) => n.resolvable === true),
            file: first.position?.new_path ?? null,
            line: first.position?.new_line ?? null,
            comments: notes.map((n) => ({
              author: n.author?.username ?? null,
              body: n.body ?? "",
              createdAt: n.created_at ?? null,
            })),
          } satisfies ReviewThread;
        })
        .filter((t): t is ReviewThread => t !== null);
    },

    publishReview(ref, verdict, summary, comments) {
      // Inline comments need the MR's diff refs (base/head/start shas). ⚠
      if (comments.length > 0) {
        const versionsOut = exec("glab", [
          "api",
          `projects/${glProject(ref)}/merge_requests/${ref.number}/versions`,
        ]);
        const versions = JSON.parse(versionsOut) as Array<{
          base_commit_sha?: string;
          head_commit_sha?: string;
          start_commit_sha?: string;
        }>;
        const v = versions[0];
        for (const c of comments) {
          const position = JSON.stringify({
            position_type: "text",
            new_path: c.file,
            new_line: c.line,
            base_sha: v?.base_commit_sha,
            head_sha: v?.head_commit_sha,
            start_sha: v?.start_commit_sha,
          });
          exec("glab", [
            "api",
            `projects/${glProject(ref)}/merge_requests/${ref.number}/discussions`,
            "-f",
            `body=${c.body}`,
            "-f",
            `position=${position}`,
          ]);
        }
      }
      // Verdict: GitLab has approval, but no "request changes" — encode it in the note. ⚠
      const prefix =
        verdict === "request_changes" ? "**Request changes**\n\n" : verdict === "approve" ? "" : "";
      if (summary.trim() || prefix) {
        exec("glab", [
          "api",
          `projects/${glProject(ref)}/merge_requests/${ref.number}/notes`,
          "-f",
          `body=${prefix}${summary}`,
        ]);
      }
      if (verdict === "approve") {
        exec("glab", ["mr", "approve", String(ref.number), "--repo", repoOf(ref)]);
      }
      return { url: ref.url };
    },

    replyToThread(ref, threadId, body) {
      exec("glab", [
        "api",
        `projects/${glProject(ref)}/merge_requests/${ref.number}/discussions/${threadId}/notes`,
        "-f",
        `body=${body}`,
      ]);
    },

    resolveThread(ref, threadId) {
      try {
        exec("glab", [
          "api",
          "-X",
          "PUT",
          `projects/${glProject(ref)}/merge_requests/${ref.number}/discussions/${threadId}`,
          "-f",
          "resolved=true",
        ]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
