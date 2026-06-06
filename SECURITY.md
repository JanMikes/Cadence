# Security & data boundaries

Cadence is a **local, single-user** tool, but this **repository is treated as public-safe**: it must
never contain anything confidential. See [`docs/platform-definition.md` §13](docs/platform-definition.md)
for the full policy. The essentials:

## Hard boundary — what may live in the repo

- **Repo = generic application code + docs only.**
- **All runtime data** — tasks, session transcripts, memory, digests, project configs, daily plans —
  lives under **`~/.cadence/`**, outside the repo, and is `.gitignore`-protected even if symlinked in.
- **Secrets live in the OS keychain** (macOS Keychain via `security`), never as plaintext in
  `~/.cadence/settings.json` and never in the repo. Settings reference a keychain item id, not the
  secret itself.
- **Redact before composing context.** Strip tokens/secrets from anything passed into a Claude
  session's prompt or `--append-system-prompt`.
- **Examples are fictional.** Docs, code, and tests use placeholder names (`ProjectA`, `Acme`) — never
  real client/project names.
- **Local-only surface.** The web UI binds to `localhost` and is auth-gated; `~/.claude/` and
  `~/.cadence/` are plaintext on disk, so the machine itself is the trust boundary.

## Commit guard (pre-commit secret scan)

A tracked pre-commit hook ([`.githooks/pre-commit`](.githooks/pre-commit)) blocks commits that contain
credentials (private keys, AWS/GitHub/Slack tokens, JWTs, `api_key=…`/`token:…`-style assignments,
`sk-…` keys) or confidential client identifiers. Combined with a hardened
[`.gitignore`](.gitignore) (`.env*`, `*.key`, `*.pem`, `secrets/`, `/.cadence/`), it prevents
accidental leaks.

**Activate it once per clone:**

```sh
git config core.hooksPath .githooks
```

(`bun install` will also wire this up automatically via the project's `prepare` script once the repo
is scaffolded.)

**Confidential client/project names** are *not* hard-coded into the tracked hook (that would itself
leak them). Instead the hook reads an optional machine-local denylist, one term per line, from:

```
~/.cadence/commit-denylist.txt          # or $CADENCE_COMMIT_DENYLIST
```

Add any real client/project names there on your machine; the file stays out of the repo.

**False positives:** if a flagged line is genuinely safe (e.g. an example pattern in docs), append the
marker `cadence-allow-secret` to that line. Use this sparingly and never to smuggle a real secret.

## Reporting

This is a personal local tool with no external users. If you fork it and find a leak in the history,
rotate the affected credential immediately and scrub the history before publishing.
