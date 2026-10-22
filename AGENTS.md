# AGENTS.md

Guidance for coding agents working on nHermes.

## Project Intent

nHermes is a small, self-hosted personal agent platform. Pi Durable runs the agents; this project adds
what Pi Durable leaves to its host (bots, sessions, approvals, memory, schedules, notifications, remote
hosts, federation, the web panel). It also adds a translation layer, so the stock Vory app can drive it
as a Hermes gateway.

Keep it small. `ARCHITECTURE.md` ends with "Why not more"; read it before adding a subsystem.

## References

- Design and trade-offs: `ARCHITECTURE.md`. Read the relevant section before cross-layer work.
- Install, service, Vory, backup, upgrade: `docs/OPERATIONS.md`.
- Hermes/Vory feature matrix: `docs/COMPATIBILITY.md`.
- What is verified, and how: `docs/STATUS.md`. Phases and what is next: `docs/BACKLOG.md`.
- Feature plans: `docs/FEDERATION.md`, `docs/REMOTE-BOT-EDITS.md`, `docs/SECRETS-AND-REVIEW.md`.
- Upstream pins and the contracts we consume: `UPSTREAM.md`. Read-only upstream clones live in
  `reference/` (gitignored; recreate them with `scripts/fetch-upstream.sh`). Read them instead of guessing
  how Pi Durable, Hermes or Vory behave. Never edit them.
- Optional maintainer guidance: a gitignored `CLAUDE.local.md` / `AGENTS.local.md` may supplement this
  file. Machine names, deployment paths and personal workflow belong there, not here. A missing overlay
  must not block an ordinary task.

## Scope And Authorization

- Apply the task's explicit scope first. A read-only audit or planning request does not authorize
  implementation. Do not commit, push, deploy or do unrelated cleanup unless the task asks for it.
- **The repository is public, and `main` is the release channel.** Deployed gateways update from GitHub
  `main` (panel "Update now", `nhermes update`). A push to `main` ships to every machine that updates.
  Push only when asked.
- Deployed gateways run from their own checkouts with their own config and data, not from this
  development checkout. Do not restart, update, or run live scripts against a deployed gateway without
  asking.
- Preserve existing working-tree changes. Inspect the actual files and diff; do not assume HEAD holds all
  local work.
- Report contradictions among the task, these docs, the code and observed behavior. Do not quietly pick
  the reading that allows more work or easier validation.

## Phased Plans And Worker Delegation

- Delegate bounded, self-contained work: codebase research, test inventories, targeted review, and
  implementation. The main agent owns the plan, design decisions, ordering, integration and user
  communication.
- Give each worker a precise scope, foreseeable edge cases, constraints, deliverables and the
  verification commands it may run. Require it to report files changed, checks run, failures and
  decisions needed.
- Inspect worker diffs before integrating or starting a dependent step.
- Do small or tightly coupled changes directly when delegation costs more than it saves.
- Workers editing in parallel must not share one gateway data directory or port. `test/helpers.ts`
  gives each test a temp dir and port 0; follow that for any ad hoc gateway.

## Architecture Rules

- **Pi Durable is the engine.** Never run a model loop here. Generation, tool calls, retries, compaction,
  the inbox, abort and restart recovery are Pi Durable's. `src/engine/` is the only owner of the
  Harness.
- **One process owns each Durable database.** `nhermes serve` opens `data/durable.sqlite`; the CLI and
  scripts never open it. They use the running service's admin API.
- **The Hermes layer only translates.** `src/hermes/` maps Vory's REST/JSON-RPC onto `core/` calls and
  canonical events back to Hermes events. No agent state lives there beyond per-socket bookkeeping. The
  same goes for `src/panel/` and `src/federation/` routes: put behavior in `core/` and call it.
- **Upstream before custom.** Providers, OAuth and `models.json` come from Pi's `ModelRuntime`; SKILL.md
  discovery from Pi's skills loader; SSH from `pi-env`; file and shell tools from `pi-durable/tools`;
  browser control from Playwright. Check `reference/` before writing something Pi already has.
- A bot is separate from its sessions. Resetting, compacting, archiving or deleting a session never
  touches the bot, its memory or its jobs.
- `app.sqlite` is ours. Schema changes are forward migrations under `schema_version` in
  `src/store/db.ts`; a running gateway upgrades in place, so never break existing rows.
- Before adding a type, helper, formatter or state machine, search with `rg` for an existing one. Put the
  behavior at its owning seam from the start; do not add it to the nearest file and promise a cleanup.

## Security And Approvals

This software runs shell commands, controls browsers and desktops, and reaches other machines. Treat
changes to these areas as security-relevant:

- Approvals are enforced on the server (`src/core/approvals.ts`, `policy.ts`, `review.ts`), never only
  in a client. A client can only answer a request the server raised.
- Delegation never raises privileges. A denied action must not succeed by routing it through a trusted
  bot, a member gateway, a job or a room.
- Every matching policy pattern must be allowed on its own. One remembered "always" never covers
  another pattern.
- Bot shells get a scrubbed environment. Known secret values are redacted from tool output, transcripts
  and events. Keep it that way when adding a tool, event or log line.
- Secrets are write-only in the panel and CLI. Never log, return or echo a token, key or PSK.
- Federation traffic between members uses the TLS-PSK port. Do not add an unauthenticated member route.
- When a security fix comes from a real finding, add a regression test and a line under "Security
  findings" in `docs/STATUS.md`.

## Privacy And Test Data

- Never commit `secrets.env`, `.env`, `data/`, SQLite files, tokens, API keys, PSKs, invite codes or
  real chat content.
- Test data and examples never name a real machine. Use `example.com`-style names and documentation
  addresses (`192.0.2.x`, `198.51.100.x`, `2001:db8::`); use `10.0.0.x` when a private address is
  needed. Tests never reach the network. They use the faux model provider, fake servers and recording
  transports.
- Comments, docs and commit messages carry no local paths, hostnames, IP addresses, device ids or
  gitignored file references. Cite tracked files or public upstream sources.

## Code Style

- TypeScript run directly by Node 24 type stripping: `erasableSyntaxOnly` means no `enum`, no
  `namespace`, no constructor parameter properties. Imports use the `.ts` extension. Tabs for
  indentation. Match the surrounding file.
- `strict` and `noUncheckedIndexedAccess` are on. Narrow properly; use `!` only where the invariant is
  local and obvious.
- Dependencies are exact versions, no ranges. Prefer Node built-ins (`node:sqlite`, `node:test`,
  `fetch`) before adding a package. The six `@earendil-works/*` packages come from one Pi release and
  are upgraded together; update `UPSTREAM.md` and run `npm run test:upstream` first after a bump.
- A file opens with a short comment saying what it owns and any invariant that is not obvious. Other
  comments explain a real invariant, compatibility fact or upstream behavior, briefly. Do not present an
  unconfirmed diagnosis as an invariant.
- User-facing text (panel, Vory messages, notifications, tool descriptions, errors) is plain and
  concrete: say what happened and what to do, without internal terms.
- The panel (`src/panel/static/`) is plain HTML, CSS and JS with no build step. It runs in embedded
  browsers and Safari: no `window.confirm`/`alert`/`prompt`; ask in the page.

## File Size And Structure

- File size is a signal, not a quota. At 800 lines, decide whether the file holds more than one
  responsibility before adding to it, and say so in the handoff. A cohesive file may stay large; a split
  follows a real seam, never a line count.
- Do not add net-new production code to a file at or above 1,000 lines without first extracting a
  responsibility, unless the user approves an exception.
- If a gate needs a broader refactor than the task authorizes, report the smallest compliant approach
  and ask.
- Keep one authoritative copy of each piece of state. Delete identity wrappers, pure forwarders and dead
  branches within the approved scope. Never delete a valid regression test to make a run pass.

## Testing

- `npm run typecheck`: under a second. Run it after every meaningful edit.
- `npm test`: the whole suite, about 150 tests in under a minute, faux model, no network. Run it before
  handing off any code change. A single file: `node --test test/core/schedule.test.ts`.
- `npm run test:upstream`: the Pi Durable contract tests. Run them after any Pi bump or engine change.
- Tests live under `test/<area>/` and mirror `src/`. Shared setup is `test/helpers.ts`; the Hermes test
  client is `test/hermes/client.ts`. A new behavior, state transition or security rule gets a test in
  the matching area.
- Wait for real events (`waitEvent`, completions, fakes' own signals). Do not add sleeps or polling loops
  to make a test pass, and do not weaken assertions or raise timeouts to get green.
- Live checks are opt-in and cost real model calls: `scripts/smoke.ts`, `scripts/approval-smoke.ts`,
  `scripts/vory-e2e.sh` (stock Vory's own E2E suite). Run them only when asked, against a gateway the user
  names.
- Panel work: `node scripts/panel-dev.ts` starts two throwaway local gateways with a fake model. Open
  the panel and look at the change, light and dark, before handing off a UI change.
- Reuse a passing result when its inputs have not changed. Documentation-only edits need no test run.

## Docs With Every Change

Each change lands as a tested commit, with its docs updated in the same commit:

- `docs/COMPATIBILITY.md` when a Hermes or Vory endpoint, method or screen changes.
- `docs/STATUS.md` when something is newly verified, automated or live. Say which, and against what.
- `docs/BACKLOG.md` when a phase item finishes or new work is deferred.
- `docs/OPERATIONS.md` when install, config, CLI or panel use changes.
- `ARCHITECTURE.md` when a boundary, data owner or principle changes.
- A feature plan's own progress section when working from one.

When review turns up work that should be deferred, report it and ask before adding it to the backlog.

## Commits

Conventional Commits with a scope, one logical change each:

```text
fix(vory): notifications about no chat carry no session_id, so tapping one no longer opens an empty chat
feat(federation): members with no notification transport forward to one that has it
docs(openchamber): oc_approve verified on a live permission card
```

- Scopes name the area: `hermes`, `vory`, `panel`, `federation`, `rooms`, `sessions`, `openchamber`,
  `scheduler`, `memory`, `skills`, `tools`, `engine`, `models`, `install`, and so on.
- The subject says what is now true for the user, in plain words, not the mechanism. Put mechanism and
  reasoning in the body when it helps.
- Lowercase after the scope, no trailing period.

## Handoff

Before handing off a code change:

- Typecheck and the full suite pass, or say exactly what failed or did not run.
- Read the whole diff. Check touched files against the size and ownership rules, and look for duplicated
  helpers or parallel state.
- For security-relevant changes, confirm the approval, privilege and redaction rules above still hold,
  and name the test that shows it.
- Docs updated as listed above.
- Report what was verified, how (automated, panel-dev, live), what was not, and any decision left for the
  user.

Implemented, verified, committed, pushed and deployed are separate states. Say which one the work is in.
