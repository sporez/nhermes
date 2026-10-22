# Backlog

Phases follow the brief. Each item lands as a tested commit; `docs/COMPATIBILITY.md` and `docs/STATUS.md`
are updated with it.

## Findings that shaped the plan (Phase 0)

- Pi Durable 1.2.0 already provides: durable conversations and runs, idempotent submissions
  (`requestId`), tool tasks with replay rules, async `beforeTool` hooks that run before intent (so an
  approval wait survives a restart without the tool running), inbox follow-up/steer, abort, compaction,
  per-conversation agent config (model, thinking, extensions, tools, instructions, cwd), task-owned child
  conversations (delegation), `watchEvents` for live streaming, SQLite storage on `node:sqlite`.
- It does not provide: bots/identities, session catalogue and titles, approvals UI/protocol, memory,
  scheduling, notifications, a network API. These are ours.
- Pi's `ModelRuntime` (coding-agent package) reads the same `auth.json`/`models.json` as the Pi CLI,
  including OAuth subscriptions (openai-codex, xai) and custom OpenAI-compatible providers (Neuralwatt,
  Synthetic, omlx); verified live on 2026-10-14. Shared use with a running Pi CLI is safe (file lock).
- `pi-env` provides SSH remote execution (Mode A) with host-key pinning and a self-deploying daemon.
- Vory's own E2E suite runs against any gateway URL + session token: it is our acceptance test.
- Vory needs `/api/config`, `/api/config/schema` (`approvals.mode`), `/api/tools/toolsets`, `/api/env`
  to be non-empty for its REST E2E test; we serve real values for those.

## Needs from the owner (remaining)

1. A second VM for `ops` to administer over SSH (currently loopback on the hermes VM).
2. Pushover user key and app token.
3. Optional: a dashboard token for the existing Hermes to capture real fixtures.

## Phases

Status per phase: see `docs/STATUS.md`.

- [x] **1. Vory connection**: config, app DB, engine boundary, bots, sessions, events, Hermes REST + WS,
  approvals, CLI `serve`/`token`, Vory E2E suite green against a real model, restart recovery.
- [x] **2. Agents and remote execution**: second bot with its own model/skills/memory, SSH host (pi-env),
  `delegate` tool (local), peer agent mode + registration.
- [x] **3. Skills and memory**: SKILL.md loading per bot and per job, `skill` tool, memory tools + FTS5,
  shared spaces, pinned memory in the prompt.
- [x] **4. Scheduling and notifications**: scheduler, job sessions, run history, missed/overlap rules,
  Pushover, Hermes cron endpoints, `schedule_*` tools.
- [x] **5. Computer use**: Playwright browser tools + E2E; Linux desktop tools over SSH + E2E.
- [x] **6. Reliability and polish**: backup/restore, systemd/Podman, upgrade/migrations, Vory UI pass,
  security review, docs.
- [x] **7. Federation and control panel**: private bots, runtime config, membership (invite/join),
  roster sync, remote bots as Vory profiles, web control panel at `/panel`. Plan: `docs/FEDERATION.md`
  (open: Vory E2E and UI pass with a remote profile, a panel "recent errors" view, a browser smoke test).
- [x] **8. Secrets in the panel and Jev permission review**: write-only key management (panel, CLI),
  optional copy to members, Jev review in the approval guard with a wider ask list. Plan:
  `docs/SECRETS-AND-REVIEW.md`.
- [x] **9. Vory settings, notifications and remote bot edits**: Vory push relay notifications, Vory's
  settings and maintenance screens, per-bot skill toggles in the panel, editing members' bots from any
  panel and from Vory. Plan: `docs/REMOTE-BOT-EDITS.md`.
- [x] **10. Group chats**: Vory's Bot Mode rooms (`groups.*`) with this gateway's bots and members'
  bots, Hermes' turn planning, member room sessions, approvals and notifications, restart recovery.
  `src/core/rooms.ts`.

## Future

- **Provider logins from the panel, on any machine.** Sign a gateway into xAI, Codex, ChatGPT, Copilot,
  Kimi and other providers from the panel or `nhermes auth`, through Pi's own login flows, with no `pi`
  CLI. Do it for any member from one panel: the login runs on that machine and its tokens never leave it.
  Plan: `docs/LOGINS.md`.

- **MCP servers, later steps** (`docs/MCP.md`): OAuth sign-in for servers that need it (pi-mcp's OAuth module,
  a panel flow like Logins), stdio servers the gateway starts, the stateless MCP 2026-07-28 once Pi's client
  speaks it, and MCP resources.

## Deferred

- **Uploaded binary files for bots on an SSH host.** Files sent from Vory are saved on the gateway
  (`src/core/attachments.ts`). Pictures, PDF pages and text files reach any bot inside the prompt, but a
  zip or spreadsheet sent to a bot with `host: ssh:` stays where that bot's tools cannot reach it; the model
  is told so. Next step if needed: copy the upload to the host's working directory through its
  `ExecutionEnv` when it is attached.

- **Chat summaries for Recent chats.** Today a new chat sees each recent chat's title, last question and
  the start of the last answer (`src/tools/memory.ts`). Next step, if previews prove too thin: once a chat
  has been idle about 10 minutes, a cheap model writes 3-5 lines on it (what it was about, what was
  decided, what is still open), kept with the chat; Recent chats shows the summary when there is one.
  Needs a summarizer model setting and an idle trigger (a chat has no explicit end).

- **Per-bot "Bot Chat" (forever-chat).** Hermes keeps one session titled "Bot Chat" per profile and reports
  it as `canonical_session` in `profiles.list`; jobs and bot-to-bot messages can land there. Vory (d99369b)
  uses it only to open a "Messaged X" notice read-only, so it is deferred until a client relies on it. Today
  a pinned chat works as a forever thread: Pi Durable compacts automatically.
