# Architecture

nHermes is a small, self-hosted personal agent platform. Pi Durable does the agent work; this
project adds what Pi Durable deliberately leaves to its host (bots, sessions as products, approvals,
memory, schedules, notifications, remote hosts) and a translation layer that lets the stock Vory app
drive it as if it were a Hermes gateway.

```
 Vory (iPhone/iPad/Mac)            nhermes CLI           Pushover
        │ HTTPS/WSS (Tailscale or TLS proxy)  │ (local HTTP)       ▲
        ▼                                      ▼                    │
 ┌──────────────────────────── nhermes serve (one Node process) ───────────────────────────┐
 │  hermes/        Hermes-compatible REST + /api/ws JSON-RPC  (translation only)           │
 │  admin/         small JSON API used by the CLI                                          │
 │  panel/         web control panel at /panel (static page + /panel/api/*)                 │
 │  federation/    members: invite/join, roster, proxy chats, /federation/manage;          │
 │                 TLS-PSK between members on the encrypted port (federation/psk.ts)       │
 │──────────────────────────────────────────────────────────────────────────────────────── │
 │  core/          bots · sessions · runs/events hub · approvals · scheduler · notifier     │
 │  memory/        per-bot memory + explicit shared notes (SQLite FTS5)                    │
 │  tools/         memory, skills, web/http, schedule, delegate, notify, browser, desktop  │
│  mcp/           MCP server connections: availability, tool snapshots (pi-mcp client)    │
 │──────────────────────────────────────────────────────────────────────────────────────── │
 │  engine/        owns the Harness: conversations, runs, events (tools/agent use Durable's │
 │                 extension API: defineTool, hooks, sections)                             │
 │                 models = pi ModelRuntime (auth.json + models.json)                      │
 │                 env    = NodeExecutionEnv | pi-env RemoteExecutionEnv over SSH          │
 └───────────────┬──────────────────────────────┬──────────────────────────────────────────┘
                 │ data/durable.sqlite           │ data/app.sqlite
                 ▼ (Pi Durable owns)             ▼ (we own)
                                  SSH ──► managed hosts (Mode A: tools run there)
                                  HTTPS ─► peer agents (Mode B: `nhermes agent` on another VM)
```

## Principles applied

- **Pi Durable is the engine.** We never run a model loop ourselves. Generation, tool calls,
  retries, compaction, the inbox (follow-ups and steering), abort and restart recovery are Pi Durable's.
- **One process owns each Durable database.** `nhermes serve` opens `durable.sqlite` once; the CLI never
  opens it. It talks to the running service over the local admin API, so there are never two owners.
  A peer agent has its own database on its own machine.
- **The Hermes layer only translates.** `src/hermes/` maps Vory's REST/JSON-RPC onto `core/` calls and
  maps canonical events back onto Hermes events. It holds no agent state of its own beyond per-socket
  bookkeeping (pending server→client request ids).
- **Upstream before custom.** Providers, OAuth and `models.json` custom endpoints come from Pi's
  `ModelRuntime`; catalog providers (`src/models/`, a key fetches the provider's model list) are
  registered into it with Pi's own `registerProvider`; SKILL.md discovery from Pi's skills loader; SSH
  execution from `pi-env`; file and shell tools from `pi-durable/tools`; browser control from Playwright.

## Canonical model

| Concept | What it is | Where it lives |
|---|---|---|
| **Bot** | A persistent agent identity: name, display name, instructions (SOUL), default model + thinking level, tool groups, skills, execution target (local dir or SSH host), approval policy, memory scope, optional peer URL | `config.yaml` (`bots:`); per-bot skill toggles in `app.sqlite` |
| **Session** | One conversation belonging to one bot. Kinds: `chat` (Vory, primary or named), `job` (scheduled runs), `delegate` (work another bot asked for), `room` (a bot's own session for a group chat thread); Vory's chat list leaves out `delegate` and `room` sessions (the panel lists them) | A Pi Durable conversation, plus an `app.sessions` row (bot, title, kind, timestamps, preview, archived/pinned) |
| **Run** | One answered input: a Durable submission and the turns it took | Durable (`pi.inbox`, tasks, entries). We only keep ids |
| **Job** | A schedule with a prompt, target bot, optional model/skills, notification policy | `app.jobs`, `app.job_runs` |
| **Memory item** | A fact or Markdown note owned by one bot, or by a named shared space | `app.memories` + FTS5 index |
| **Room** | A group chat of 2-6 bots (this gateway's or members'): its members and one ordered log of typed events | `app.rooms`, `app.room_events`, `app.room_sessions`, `app.room_turns` |

A bot's identity is separate from all of its sessions. Resetting, compacting, archiving or deleting a
session never touches the bot, its memory or its jobs. In Hermes terms, a **profile is a bot**; there is
no other "worker/agent/profile" concept.

Session ids are Durable conversation ids. The Hermes runtime id and stored id are the same string.

## Engine boundary (`src/engine/`)

The only module that opens and drives the Pi Durable Harness. (Tool and extension modules use
Durable's extension API, `defineTool`/`hook`/`section`, since that is how tools plug in; `core/` and
`hermes/` never import it.) It exposes a narrow interface:

- `open()` / `close()`; `resume()` on start so interrupted runs continue.
- `createConversation(botId, agentConfig)`, `configure(id, change)`, `submit(id, content, requestId, mode)`
  (text, or text and image blocks; pictures are shrunk by Pi Durable's Photon processor, `engine/images.ts`),
  `abort(id)`, `entries(id)`, `watch(id, listener)` (wraps `watchEvents`), `usage(id)`.
- Extensions installed in the registry: core tools (`read/write/edit/bash`), our tool groups, the
  `persona` section (bot instructions + pinned memory + recent chats + skill index), and the `guard` extension whose
  `beforeTool` hook is the approval gate.
- `env` callback: resolves the conversation's bot and returns its execution environment
  (`NodeExecutionEnv` with the bot's workspace, or a cached `RemoteExecutionEnv` for an SSH host).

`test/upstream/` exercises exactly this surface against the real packages with the faux provider, so a
Pi upgrade that changes it fails there first.

## Events

`engine.watch()` turns Durable `AgentEvent` batches into canonical events:
`run.started`, `text.delta`, `reasoning.delta`, `tool.started`, `tool.output`, `tool.finished`,
`run.finished {text, status, usage, error}`, `approval.requested/resolved`, `session.updated`.
The hub fans them out to subscribers: Hermes sockets attached to the session, the scheduler waiting on
a job run, a delegation waiting for its answer. A client that reconnects gets a snapshot from
`session.resume` (transcript + `running` + `inflight` partial + open approvals); nothing is replayed
frame by frame, which is also how Pi Durable's own watches work.

## Approvals and permissions

Every tool call passes the `guard` extension's `beforeTool` hook, which runs **before** Pi Durable
records the call's intent:

1. The bot's policy classifies the call: `allow`, `ask`, or `deny` (rules on tool name, and on shell
   command patterns for `bash`/remote shell; for example `rm -rf`, `mkfs`, `zfs destroy`, `dd of=`,
   credential files).
2. `ask` creates an approval request, sends a Hermes `approval` server→client request to every socket
   attached to the session, and waits (cancellable by interrupt, with a timeout that fails closed).
3. `once` lets this call run; `session` adds the rule to the session's allow list; `always` adds it to
   the bot's allow list (in `app.sqlite`); `deny`/timeout blocks the call and the model is told so.

If the gateway restarts while a call waits, the call has no intent yet, so Pi Durable reruns the `call`
phase and the question is asked again; nothing ran. Scheduled runs (no client) use the job's
`approvals: deny|allow` policy and notify on a denied action instead of waiting.

Every bot's prompt carries fixed ground rules (`groundRules` in `src/agent/extensions.ts`): do ordinary
work on the owner's machine and apps with the tools it has, but say so rather than fake a missing reach
(another bot, gateway or machine), reach other bots only through `delegate`, and leave the gateway's own
config, secrets, databases and API alone. A bot's shell runs as the gateway's user, so these
rules, the approval guard and the operating-system user are what keep it from the gateway's secrets.

Jev permission review (`src/core/review.ts`): when the guard would ask and the reasons are all
reviewable (not the destructive group, an owner ask rule or manual mode; not a job or another machine's
work), Jev gets the owner's recent messages from the chat where the work started, the delegated task
texts (marked as not the owner's), and the call. A confident allow runs; anything else is the card, with
Jev's view. Reviews are logged in `app.sqlite` (`reviews`) and listed in the panel.

Trust boundaries: bot instructions and configured hosts are owner-trusted. Tool output (web pages, files,
logs, API responses) is untrusted content; it never changes policy, and approvals are keyed on what the
call does, not on what a page said. A bot marked `trusted: true` with a host gets broad shell and sudo,
with only the high-impact patterns asking.

## Tools

| Group | Tools | Notes |
|---|---|---|
| `files`, `shell` | `read`, `write`, `edit`, `bash` | Pi Durable's own, run in the bot's env (local or SSH) |
| `web` | `web_fetch`, `http_request` | `fetch` with size/time limits; credentials as `{{secret:NAME}}` for env vars the bot lists under `secrets:`, scrubbed from results |
| `memory` | `remember`, `recall`, `forget`, `memory_list`, `memory_update`, `chat_search`, `chat_read` | Scoped to the bot; shared spaces only when granted; chats are the bot's own with the owner |
| `skills` | `skill` (load a SKILL.md by name) | The prompt lists names + descriptions only |
| `schedule` | `schedule_create/list/update/delete/run/history` | Same service the Vory cron screens use |
| `delegate` | `delegate` (ask another bot, wait or not) | Durable child conversations / peer HTTP |
| `notify` | `notify` (Vory and/or Pushover) | |
| `openchamber` | `oc_sessions/read/waiting/diff`, `oc_approve/answer/stop/prompt/start` | OpenChamber's local server on the same Mac (`src/openchamber/`); control tools always ask the owner. The tool-less `openchamber_alerts` group turns on the event watcher that notifies about requests and failed threads |
| `browser` | `browser_open/snapshot/click/type/select/press/scroll/back/wait/screenshot/tabs` | Playwright, persistent isolated profile per bot |
| `desktop` | `desktop_screenshot/click/type/key/scroll/windows/focus/launch/accessibility` | X11 on the bot's host (gateway or SSH): `import`, `xdotool`, `wmctrl`, AT-SPI |
| `mcp:<server>` | `mcp__<server>__<tool>` for each tool the server lists (narrowed by its include/exclude) | One group per configured MCP server (`src/tools/mcp.ts`). The server's last known list, kept while it is offline; re-installed as Durable's `mcp` extension when a list or the config changes. `exposure: deferred` leaves them out of the request until `tool_search` loads them. Not read-only (by the owner's `tools.readOnly`) → asks; read-only → `replay: "safe"` |
| `self` | `self_info`, `self_models` (the pickers' model list), `nhermes_docs`, `self_update`, `self_skill_write/delete`; trusted bots also `gateway_bot_update/add/remove`, `gateway_update`, `gateway_reload`, `gateway_skill_write/delete`, `gateway_software` | Adds the `about` prompt section (what nHermes is, the bot's live settings, a docs map). Edits go through `Settings`; every change asks the owner with a diff (never Jev, no "always"); refused in jobs, from network members, and (gateway tools) through an untrusted delegation chain. `src/tools/self.ts` |

Long-running tools stream output through Pi Durable's `api.output()`, honour cancellation through the
call's context, declare timeouts, and are `replay: "unsafe"` unless they are read-only
(`web_fetch`, `recall`, `skill`, `browser_snapshot`, `desktop_screenshot` are `safe`).

## MCP servers (`src/mcp/`, `docs/MCP.md`)

An MCP server is an optional capability whose availability can change at any moment; the gateway stays fully
usable whatever the servers do. Config: `mcp.servers.<name>` in config.yaml (Streamable HTTP, headers whose
values may name `{{secret:NAME}}` from secrets.env). The client is Pi's `pi-mcp` (protocol 2025-11-25 and
earlier, so a server must answer `initialize`; one that speaks only the stateless 2026-07-28 is reported as
set up wrong).

- **One connection per server** (`McpConnection`): states `connecting`, `online`, `offline`, `needs_key`,
  `failed`, `disabled`. Only `online` is available. pi-mcp keeps a client "connected" after any failed
  request, so availability is ours: a successful initialize, request or idle health check (`ping`, every
  `healthCheckS`) makes it online; two missed checks, or a call that shows the server unreachable, take it
  offline. Offline retries back off (5 s doubling to 5 min, jittered); a refused key or a broken setup retries
  every 30 min, or at once when the key or config changes. A state change is logged once, not per attempt.
  Starting never waits for a server, and no server waits on another.
- **Calls** are sent at most once: no queue, no replay after a reconnect. The one exception is a 404 on an
  expired session, which the spec defines as not processed. A call that finds its server offline makes one
  short reconnect attempt (3 s) and otherwise fails at once. Every failure is classified
  (`src/mcp/outcome.ts`) by whether the tool may have run: never sent, refused, or unknown (dropped after
  sending, timed out, server error).
- **A down server keeps its tools declared**, and calls to it fail fast with what happened, so the model can
  tell the owner "the calendar is offline" instead of believing it never had one, and no chat's tool list
  churns as a laptop sleeps and wakes. Tools leave only when the owner changes the config or a fresh list
  drops them (Durable answers a stale call with `tool_unavailable`). A call on an idle connection is preceded
  by a `ping`, so a dead pooled connection fails there and the call is reported as not sent. The bot's prompt
  names its servers and the owner's descriptions, never live status.
- **Tool snapshots**: the last tool list per server is kept in `app.sqlite` (`mcp_snapshots`), so its tools
  are known while it is offline and after a restart, with a log of what changed between lists
  (`mcp_changes`). A list is taken at every (re)connect and on `notifications/tools/list_changed`. A changed
  URL is a different server: its snapshot is dropped.
- A server URL comes only from the owner's config, never from a model, and may not be this gateway itself;
  redirects are refused so headers never follow one; the client declares no capabilities (no sampling,
  elicitation or roots).

## Skills

Standard `SKILL.md` directories, loaded with Pi's loader:

- `skills/` (global; a bot opts in with `skills: ["*"]` or a list), `bots/<name>/skills/` (per bot),
  and `skills:` on a job (attached to that job's runs only).
- The system prompt carries only the index (name, description); the `skill` tool returns the body when
  the model decides it is relevant. `GET /api/skills?profile=` shows which are active for a bot, and
  `PUT /api/skills/toggle` enables or disables one per bot; the panel's Skills section uses the same
  path (`Skills.setEnabled`, stored as bot overrides).

## Memory

`app.sqlite` table `memories(id, owner, kind, title, body, tags, source, pinned, created_at, updated_at)`
with an FTS5 index. `owner` is a bot name or `shared:<space>`. A bot reads its own memories and the
shared spaces listed in its config; nothing is merged automatically. Pinned items render into the
`persona` section (small budget), so they survive compaction; everything else is reached through
`recall`. Provenance: `source` records the session and entry (or "user", "job:<id>").
Conversation history stays in Pi Durable and is not copied into memory.

**Recent chats.** A new chat of a bot with the memory tools gets a "Recent chats" section: its latest
`recentChats` chats with the owner (default 5, `0` turns it off), each with its id, date, title, last
question and the start of the last answer. Jobs, delegated tasks, archived chats, chats with a member's
bot and work a member started are left out. The section is worked out at the chat's first prompt and kept
in `sessions.recap`, so the prompt stays the same (and cacheable) for the life of the chat; chats from
before this feature keep `''`. `chat_search` (whole text of the latest 40 chats, titles and last answers
of older ones) and `chat_read` (one chat in pages, latest first) reach the rest, limited to the same chats.
In the panel: Recent chats in the bot editor, the section in its System prompt view, and each chat's
saved list under Sessions.

## Scheduling

`core/scheduler.ts` with `croner` for cron expressions in a time zone (DST-correct), plus one-shot
(`at`) and interval (`every`) schedules. A tick every 15 s computes due jobs from `next_run_at`.

- **Idempotent start:** each occurrence has a key `job:<id>:<scheduled-iso>`. The run row is inserted
  with a unique constraint and the Durable submission uses the same `requestId`, so a restart in the
  middle never starts the occurrence twice.
- **Overlap:** a job whose previous run is still active skips the occurrence (recorded as `skipped`).
- **Missed runs:** at start-up, occurrences missed while down are coalesced into one catch-up run if
  the job's `catch_up` window allows it (default: run once if missed by less than 6 h), otherwise
  recorded as `missed`.
- **Restarts:** an in-flight run continues because the Durable run does (`harness.resume()`); tools
  that were mid-execution are not replayed unless they are replay-safe (Pi Durable rule). The run
  record waits on the same submission after restart.
- **Results:** each job has one session (kind `job`, listed in Vory); every run starts it from a fresh
  context (Durable reset), so runs are independent while their history stays readable. `context: continue`
  skips the reset so runs share one thread (Durable compacts it as it grows); switching a job to it
  continues from the last run. `deliver: chat`
  also posts a notice into the bot's most recent chat; `notify: never|always|on_error|on_change|agent`
  decides the notification (`agent`: the run calls `notify` itself).

Exactly-once is **not** claimed for side effects: Durable request deduplication only guarantees the
run is not submitted twice.

## Delegation and remote agents

- **Local delegation:** the `delegate` tool creates a Durable conversation owned by the calling tool
  task for the target bot (pattern of Pi's `22-subagent-foreground`), configured with the target bot's
  model, instructions and tools, and records it as a `delegate` session of the target bot. The result
  returns to the caller as the tool result. `wait: false` uses a background task that posts the answer
  back into the caller's session as a follow-up (pattern `23-subagent-background`).
- **Mode A (remote execution):** a bot with `host: { ssh: ... }` runs its file and shell tools on that
  host through `pi-env`'s `RemoteExecutionEnv`; conversations, credentials and state stay central.
  Host keys are pinned in the gateway's own known-hosts file.
- **Mode B (peer agent):** a peer is simply another `nhermes serve` on another machine, with its own
  Durable database and bots. No second protocol: the central gateway talks to it over the same Hermes
  WebSocket Vory uses (`session.create`, `prompt.submit` with `idempotency_key` → the peer's Durable
  request id, `session.resume` after a dropped connection). A peer is configured as a bot with
  `peer: { url, tokenEnv, profile }` (the token goes in an `Authorization: Bearer` header, never the URL; a
  plain `http://` URL to another machine logs a warning at load); local bots reach it with `delegate`, and its approval requests are
  relayed to the owner's chat on the central gateway. `wait: false` works for bots on other machines
  too: a background task (`nh.delegate-remote`) starts the chat there, records its id, submits under a
  fixed key and waits (reconnecting, for up to a day), then posts the answer into the caller's chat; a
  restart of either side resumes it without sending the task twice. Peers are not listed as Vory profiles; to chat
  with one directly, add it to Vory as its own gateway.
- **Network of members (`src/federation/`, `docs/FEDERATION.md`):** gateways join one network of equals
  with `nhermes invite` / `join`; each pair shares a generated secret (`members`) that keys a TLS-PSK
  link on the encrypted port; it never travels. Members reach only `/federation/*` and the WebSocket,
  never `/api/*` or `/admin/*`. Each member publishes its shareable bots (`/federation/roster`); the
  others list them as `<bot>-<node>` (`remote_bots`, kept while a member is offline) and delegate to them
  over the WebSocket like a peer. On the owning gateway such a chat has source `member:<node id>`: a
  member's connection sees only those chats and shareable bots, cannot turn approvals off, and the work
  is never trusted.
- **Editing members' bots (`src/federation/manage.ts`, `docs/REMOTE-BOT-EDITS.md`):** when a gateway's
  owner allows it (panel, Network), the other members' panels list its bots, private ones included, with
  the same editor as local bots. The panel calls `/federation/manage/*` on the owning gateway with the
  pair secret, which applies the edit through its own `Settings` and skills; host, workspace, keys and
  gateway settings stay editable only on that machine. Vory's settings requests for a `<bot>-<node>`
  profile follow the same path (`src/federation/vory.ts`): reads always, changes under the same switch.
  The same switch covers its MCP servers (`/federation/manage/mcp/*`); key values never travel.
- **MCP servers belong to the machine that configures them**: only its bots call them, and the calls go
  out from that machine. Another machine reaches them by delegating to such a bot, so the work stays
  untrusted there and its approvals come back to the chat that started it; there is no second path.
- **Signing members in (`src/federation/logins.ts`, `docs/LOGINS.md`):** when a gateway's owner allows it
  (its own switch), other members' panels and `nhermes auth --machine` call `/federation/logins/*` over the
  pair secret. The login runs in that gateway's `core/logins.ts`; codes and prompts travel, credentials do not.
- **Private bots:** `private: true` leaves a bot out of the other bots' roster and makes `delegate`
  answer as if it did not exist; it is not shared with members either. It can still delegate to others
  and is still a Vory profile on its own gateway.
- **Privileges never escalate through delegation:** a delegated task is trusted only if every bot in the
  chain is, and runs under the strictest approval mode in the chain.

## Group chats (`src/core/rooms.ts`)

Vory's Bot Mode rooms, in Hermes' `groups.*` shapes. The room log is the state: after every change the
room's driver replays it with `planNextTurn` (`src/core/room-plan.ts`, a port of Hermes'
`plan_next_task`) and runs at most one member turn at a time. Round 0 is the bots the owner's message
@mentions (everyone when it mentions none); rounds 1-2 are bots another bot @mentioned and that have not
answered since; a `(pass)` reply files nothing; a silent round settles the discussion, and 3 rounds or 10
bot messages bound it.

- **A turn:** `turn.started`, the prompt (the thread's messages since that bot last read, and the rules)
  submitted to the bot's own room session (kind `room`, one per room thread, configured like any session
  of that bot), then `message.member` + `turn.settled`, or `turn.failed`, in one transaction.
- **Restarts:** the submission uses the request id `room:<room>:<turn>` and is kept in `room_turns`; a
  restart waits for that submission instead of sending the turn again. A turn left open that a newer
  message has overtaken is still finished from its submission.
- **Approvals** are the guard's, unchanged: asked in the member's room session (Vory's approval
  notification opens it), with a `room.activity` line saying who waits. Jev reads the owner's words from
  the room log, since a turn's prompt also carries other bots' words; later lines of a message are
  indented in prompts so a bot cannot write a line that reads as the owner's.
- **Notifications:** one when an exchange settles or is bounded with new bot replies.
- **Members' bots** answer on their own machine: their room session is made there with `session.create
  {kind: "room"}` (as work this gateway started, so untrusted there and its approvals come back here),
  catalogued here under the same id so Vory opens it through the member link, and each turn runs with
  `runOnPeer` keyed by the turn. Its prompt is kept in `room_turns`, so a restart sends it again under the
  same key and the member drops the repeat. An offline member's turn fails at once.
- The room lives on the gateway Vory created it on. Vory polls `groups.log`; nothing is pushed over the socket.

## Hermes compatibility layer (`src/hermes/`)

- REST: `/api/status`, `/api/profiles` (+ `active`, `soul`), `/api/sessions` (list/get/messages/patch/
  delete/search), `/api/model/options`, `/api/skills` (+ toggle), `/api/cron/jobs` (+ runs, pause,
  resume, trigger, update, delete), `/api/config` + `/api/config/schema`, `/api/env` (redacted),
  `/api/tools/toolsets`. Vory's settings and maintenance screens (`hermes/manage.ts`): config and tool
  group writes, the default model, keys, creating and removing bots, update/restart/doctor with
  `/api/actions/{name}/status`, logs, usage analytics, and a read-only Files browser over the bots'
  workspaces. Unknown routes answer 404; nothing is stubbed to look functional.
- WebSocket `/api/ws`: JSON-RPC 2.0, newline-delimited, `gateway.ready` first, `ping`, server→client
  `approval` requests, events with the Hermes envelope. Methods: see `docs/COMPATIBILITY.md`.
- Auth: session token (`X-Hermes-Session-Token` header, `?token=` on the socket); a wrong token is HTTP
  401 / WebSocket close 4401.

## Persistence and operations

`data/` holds `durable.sqlite` (Pi Durable), `app.sqlite` (ours, with a `schema_version` table and
forward-only migrations; it also keeps MCP servers' last tool lists), `workspaces/<bot>/`, `browser/<bot>/` (Playwright profiles), `ssh/known_hosts`,
`vory/` (Vory push registrations); logs go to stderr (journal / launchd log), with the last 500 lines
kept in memory for `/api/logs`. Files and pictures sent from a client are written to the bot's workspace
`uploads/` folder, never over another file; `src/core/attachments.ts` holds what waits for a session's next
prompt (in memory, as Hermes does) and the `@file:` references it handed out, the only ones it expands.
Secrets come from `secrets.env` (provider keys, Pushover, gateway token) or Pi's `auth.json`;
they are never in prompts, transcripts or logs (the logger redacts known secret values).
Provider sign-ins (`src/core/logins.ts`) run Pi's own login flows inside the gateway, which is the only writer of
`auth.json`; the sessions are in memory, the CLI and panel only relay a flow's prompts and answers, and tokens never leave
the machine.

Backup: `nhermes backup` asks the running service (over its admin API) for consistent copies
(`VACUUM INTO` for both databases) plus config, skills, workspaces and browser profiles, in one tarball. Restore: stop the service, `nhermes
restore <file>`, start. Deployment: one systemd unit (or a rootless Podman quadlet). See `docs/OPERATIONS.md`.

## Why not more

No Postgres, Redis, broker or orchestrator: one owner, one process, two SQLite files. No vector store:
FTS5 is enough until a concrete recall failure shows otherwise. The web panel (`src/panel/`) is static
HTML, CSS and JavaScript with no framework or build step. No messaging-platform integrations: Vory for conversation and its own notifications (through the
Vory push relay, `src/notify/vory.ts`), Pushover as an optional second channel.
