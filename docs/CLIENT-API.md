# nHermes client API (plan)

Status: in progress (phase A).

## Goal

nHermes gets its own client API, designed for the native nHermes app (Mac, iPhone, iPad) instead of copied
from Hermes so the stock Vory app could connect. The gateway moves first, then the app's engine
(NHermesKit), then the Hermes layer and every Vory remnant are deleted.

The shape is built to change: new resources, fields, event types and features are added without a new
version, and a client gates features on what the gateway says it offers.

**Bar for done:** everything a user can do today, in the app, the panel, the CLI, through bots' tools and
across the network, still works. Features only Vory used today (group chats, Files, usage analytics,
logs, doctor, update and restart, keys, config) stay on the new API, so the app can add their screens later.

## Where we start

- `src/hermes/` speaks Hermes's REST routes and its `/api/ws` JSON-RPC (`docs/COMPATIBILITY.md`). The app
  speaks the same contract (NHermesKit `Networking/`).
- **Network members talk to each other over that same socket:** `src/federation/link.ts` and `proxy.ts`
  (chats with a member's bot, approvals relayed back), `src/remote/peer.ts` (`peer:` bots, delegation to
  members, a member bot's turn in a group chat). `src/federation/vory.ts` forwards Vory's settings
  requests for member bots by matching URL patterns.
- The HTTP listener for everything (panel, federation port, admin routes) lives in `src/hermes/server.ts`.
- Vory-shaped data loss the app works around today:
  - History is flat rows (`core/transcript.ts`): tool rows have no call id, arguments, error flag or
    duration; results are cut at 2,000 characters (4,000 live); there is no run end time. The app guesses
    failures from text prefixes (`TranscriptBuilder.swift`).
  - Attachments travel as text marks (`[User attached image: …]`, `📎 …`, `@file:…`) that the app reads
    back with regexes; uploads wait in memory with no way to withdraw one; `/api/media` serves only
    pictures.
  - Events: one `message.start` per run, no reply-part boundaries (the app splits on `tool.start`), the
    whole run's text joined in `message.complete`, a denied tool sends only `tool.complete`, change
    events have no payload.
  - Approvals reach only sockets attached to that chat; an answer from another device is not announced
    (Hermes behaviour, copied on purpose). The app subscribes to every running chat and polls
    `approval.pending`.
  - Settings as strings: `config.set model "<m> --provider <p> --session"`, reasoning words mapped onto
    thinking levels, the no-approvals switch (YOLO) kept in memory because "Vory re-sends it".
  - Member bots are encoded as `<bot>-<node>` names with `"Name (node)"` display names; `"default"` is a
    magic profile name.
  - Phone notifications only through Vory's push relay (`src/notify/vory.ts`, which fakes Vory's
    Companion plugin through a files API).
- What Durable already records and we can use: tool results carry `durationMs` and `isError`
  (`core/live.ts`), tool calls carry their arguments, messages carry timestamps. Entries carry no time of
  their own, and nothing marks when a run ended.

## Design

### Principles that keep it extensible

1. **One version number, rarely changed.** Everything lives under `/api/v1/`. Within v1, changes are
   additive only: new endpoints, new optional fields, new event types, new enum values. A field is never
   removed or given a new meaning in v1. A breaking change would be `/api/v2` served next to v1 until
   clients move.
2. **Features, not versions.** `GET /api/v1` (the hello) returns the gateway's identity, the API version,
   a list of feature strings (`rooms`, `attachments`, `push.apns`, `events.replay`, …) and limits (upload
   size, result caps). The client shows a feature only when its string is present. A new capability is a
   new string.
3. **Tolerant clients.** Clients ignore unknown fields and unknown event types, and decode every enum
   with an "unknown" fallback (Swift: an `.other(String)` case). The gateway ignores unknown request
   fields. New request fields are always optional, with a default that keeps the old behaviour.
4. **One operation table, two transports.** Each operation is declared once in `src/api/ops/`: a name
   (`sessions.submit`), an HTTP route (`POST /api/v1/sessions/:id/submit`), its handler, who may call it
   (owner, or also network members), and whether a call about a member's bot or chat is forwarded to that
   member. HTTP and the WebSocket dispatch from the same table, so every operation works over both, and
   tests can use either. This one table replaces `MEMBER_METHODS`, `PROXIED` and the URL patterns in
   `federation/vory.ts`.
5. **One shape per resource.** A bot, session, turn, approval or job has one serializer
   (`src/api/shapes/`). Lists, gets, change events, the snapshot and federation all use it.
6. **Typed, discriminated content.** Anything that can grow new kinds is a list of objects with a `type`
   field: message content blocks, turn items, events, room log events. A new kind of item (for example a
   card, a picture the bot made, a sub-agent's work) is a new `type`; old clients skip it.
7. **Ids for everything that is referred to later:** turns, items (tool call ids), attachments, approval
   requests, jobs and runs, devices, actions. The ids we store today keep their values (session ids, bot
   names, `<bot>-<node>` for a member's bot), so no stored row changes. Clients treat ids as opaque.
8. **Conventions:** JSON in camelCase (as the panel, admin API and core already use), times as Unix
   milliseconds, `Authorization: Bearer <token>` on HTTP and on the WebSocket upgrade (no `?token=`:
   URLSession and `ws` both set headers, and tokens in URLs end up in logs). Lists return
   `{items, nextCursor}`. Changes use `PATCH` with only the changed fields and answer with the whole
   object.
9. **Errors** are `{error: {code, message, details?}}` with a fitting HTTP status, and the same object in
   a WebSocket reply. `code` is a stable string (`session_not_found`, `member_offline`, `not_allowed`, …)
   from one registry (`src/api/errors.ts`); `message` is plain words a user can read.

### Transport

- **HTTP** for every operation, including uploads and downloads (binary bodies, not base64).
- **WebSocket** `/api/v1/ws` for live events and, for latency, any operation. Frames:
  - call: `{id, op, params}`, reply `{id, result}` or `{id, error}`
  - event: `{type, sessionId?, seq?, at, data}`
  - The gateway sends `hello` first (the same body as `GET /api/v1`) and pings on its own; the client
    may ping too.
- There are **no server-to-client requests.** An approval is an event; any device answers it with
  `approvals.answer`. That makes multi-device answers, federation relays and notification actions the
  same path.
- **Subscriptions:** an owner socket gets gateway-wide events without asking (session, bot, job,
  approval, room, MCP, member and action changes). `sessions.subscribe {id, afterSeq?}` adds a chat's
  live events and answers with a snapshot. Each chat's events carry a `seq`. Phase A2 always answers with a
  snapshot (what the app relies on today). A later step keeps a short in-memory buffer of recent events
  per chat, so a reconnect with `afterSeq` within it gets only the missed events (feature
  `events.replay`). A gateway restart is detected by the hello's `bootId`.
- `/api/health` stays as it is, without a version: installers and older `nhermes update` runs poll it.

### Resources (first cut; `docs/API.md` becomes the reference)

- **Gateway:** `GET /api/v1` hello; `GET/PATCH /gateway/settings` (time zone, approval timeout, defaults,
  hidden model providers); `GET /gateway/logs`; `GET /gateway/usage?days&botId` (analytics).
- **Bots:** `{id, name, displayName, description, isDefault, node: null | {id, name, online},
  kind: "local" | "member" | "peer", model: {provider, id}, thinking, approvals: {mode}, toolGroups,
  skillCount, private, trusted, editable, avatar: null}`. `GET /bots`, `GET/PATCH/DELETE /bots/:id`,
  `POST /bots` (create, optional `cloneFrom`). `PATCH` takes the panel editor's fields (`Settings.editBot`,
  instructions included), so the app, the panel and member edits share one field set. For a member's bot
  it goes to that member's `/federation/manage/*`, under its "let other machines edit" switch.
  `GET /bots/:id/skills`, `PUT /bots/:id/skills/:name {enabled}`; `GET/PUT/DELETE /bots/:id/rules`
  (always-allowed approval rules); `GET /bots/:id/prompt` (the system prompt in parts, as the panel
  shows it).
- **Sessions:** `{id, botId, kind, title, preview, source, createdAt, lastActiveAt, messageCount, running,
  archived, pinned, model, thinking, yolo, approvalMode, usage?}`: today's list row and `sessionInfo`
  in one. `GET /sessions?botId&kind&archived&q&cursor`, `POST /sessions`, `GET/PATCH/DELETE
  /sessions/:id`. `PATCH` covers title, pin, archive, model, thinking and YOLO; there is no string-command
  form.
- **Turns (history):** `GET /sessions/:id/turns?before&limit`. A turn is
  `{id, status: running | complete | error | interrupted, startedAt, endedAt?, user: {content, at},
  items, usage?}`. `content` is blocks: `{type: "text", text}`,
  `{type: "attachment", attachment}`. Items:
  - `{type: "reasoning", id, text, startedAt?, endedAt?}`
  - `{type: "text", id, text, at}` (one reply part)
  - `{type: "tool", id (the call id), name, args, preview, status, isError, startedAt, durationMs,
    result: {text, truncated, length, json?}}`
  - `{type: "notice", kind, text}`, `{type: "error", message}`

  A run's end and status are recorded by us as a bookkeeping entry when it finishes (as `nh.notice`
  already is), so new chats get real durations; older chats show what they have. `args` are the call's
  arguments, redacted. Results are sent whole up to 64 KB (in the hello's limits); a longer one is marked
  `truncated` and `GET /sessions/:id/items/:itemId/result` returns it all.
- **Whole MCP results.** Today the model gets an MCP result up to 20 KB (`src/tools/mcp.ts`), but clients
  get 4,000 characters live and 2,000 in history, so the app's MacBridge cards show about 12 reminders
  live and 6 in a reopened chat. With the caps above, the result text arrives whole. `json` is the
  server's `structuredContent`, kept by the MCP tool in the result's details (capped at 256 KB, redacted),
  so cards no longer parse text when a server sends structured data. The model's view does not change.
- **Live chat events** are built from the same shapes, so the app applies history and live updates
  with one code path: `turn.started {turn}`, `item.started {turnId, item}`,
  `item.delta {turnId, itemId, text}` (reply text, reasoning, and a tool's streamed output, which the
  engine already produces as `tool.output`), `item.finished {turnId, item}`,
  `turn.finished {turn}`, `session.updated {session}`, `usage.updated {usage}`.
- **Chat operations:** `POST /sessions/:id/submit {content, requestId?}` (queued while busy, as today;
  `requestId` is the idempotency key), `/steer`, `/interrupt`, `/compact`; `GET /sessions/:id/usage`,
  `/context`; `GET /sessions/:id/commands` (the slash catalog: built-ins and skills),
  `POST /sessions/:id/commands {name, args}`.
- **Attachments:** `POST /sessions/:id/attachments` (binary body, file name and type in headers) returns
  `{id, name, mime, size, kind: image | pdf | file, pages?}`; `DELETE /sessions/:id/attachments/:aid`
  withdraws one not yet sent; `submit` names them in `content`. `GET /attachments/:id/content` serves any
  kind, in old chats too. A new `attachments` table in `app.sqlite` maps ids to the files in the bot's
  `uploads/` (forward migration). What the model reads stays as today; only the wire changes. Chats from
  before the change show their attachments by name, as now.
- **Approvals:** `{id, sessionId, botId, toolName, command, description, choices, patternKey, createdAt,
  review?, fromNode?}`. `GET /approvals` (every pending one), `POST /approvals/:id {choice}`. Events
  `approval.requested` and `approval.resolved {id, choice, reason, by}` go to every owner socket, whoever
  answered.
- **Jobs:** `GET/POST /jobs`, `GET/PATCH/DELETE /jobs/:id`, `GET /jobs/:id/runs`, `POST /jobs/:id/run`,
  `/pause`, `/resume`. Run now answers at once with the run; `job.updated` events follow it (no 25 s
  hold).
- **Models:** `GET /models?botId` → providers with models and capabilities (reasoning, the thinking
  levels it takes, image input), and the bot's current model. Thinking levels use Durable's names (`off`
  … `xhigh`), with no translation.
- **Rooms (group chats):** `GET/POST /rooms`, `GET/DELETE /rooms/:id`, `POST /rooms/:id/messages`,
  `GET /rooms/:id/events?afterSeq`. The typed room log stays as it is. New: `room.event` is pushed to
  owner sockets, so a client no longer has to poll.
- **MCP:** `GET /mcp/servers?botId`, `PUT /mcp/servers/:name/bots/:botId {enabled}`,
  `POST /mcp/servers/:name/test`, `DELETE /mcp/servers/:name`; member bots forwarded as today.
- **Keys:** `GET /keys` (redacted), `PUT /keys/:name`, `DELETE /keys/:name`. Write-only; the gateway
  token is refused, as today.
- **Files:** `GET /files?path`, `GET /files/content?path` (read-only, inside bots' workspaces, as today).
- **Actions:** update, restart and doctor as one resource. `GET /software` (version, commits behind,
  whether it can apply); `POST /actions {kind: "update" | "restart" | "doctor" | "check"}` returns an
  action; `GET /actions/:id`; `action.updated` events. Rollback stays in the panel and CLI.
- **Devices and notifications (phase E):** `GET/POST /devices`, `DELETE /devices/:id`,
  `POST /devices/:id/test`. A device is `{id, platform: "apns", token, environment, bundleId, name,
  kinds}`. A notification payload is `{kind, title, body, sessionId?, botId?, approvalId?, jobId?,
  threadId, collapseId}`, with actions on approval notifications that call `POST /approvals/:id`.

### Code layout

```
src/server.ts          the listeners (main, federation PSK port), auth, panel and federation mounts (moved from hermes/server.ts)
src/api/server.ts      /api/v1 HTTP routing and the WebSocket, both dispatching from the op table
src/api/ops.ts         the op table type, dispatch, member access, forwarding to members
src/api/ops/*.ts       one file per resource: sessions, chat, approvals, bots, jobs, rooms, models, mcp, gateway, files, actions, devices
src/api/shapes/*.ts    the serializers
src/api/events.ts      canonical events → wire events, seq, (later) the replay buffer
src/api/errors.ts      error codes
src/api/types.ts       the wire types (the one source docs/API.md describes)
test/api/              client.ts and tests per area
```

Behaviour stays in `core/`; `src/api/` only translates, as `src/hermes/` does now. Files stay under the
size rules: `ws.ts` (615 lines) is not copied into one new file.

### Federation

- Members connect to `/api/v1/ws` on the encrypted port. The op table marks what a member may call, and
  the member checks of today (only chats it started, no YOLO, private bots hidden, `member:` sources,
  `relay`) move into the dispatcher unchanged.
- `MemberLink`, `ProxySessions` and `peer.ts` use ops and the new events. Approval relay: the member's
  socket receives `approval.requested` for its chats; the asking gateway raises its own request through
  `approvals.ask` and answers with `approvals.answer`. The owner's approval rules do not change.
- Uploads into a member's chat go over the link as base64 inside the op (only members use this path),
  within today's 40 MB.
- No fallback to the old protocol. While a network updates, a member on the old version answers the new
  socket with 404, and the link says "`<member>` runs an older nHermes; update it". Downtime here is
  acceptable.

## Phases

Gateway first, then the app, then deletion, then push. While A and C run, the gateway serves the old and
new APIs side by side, so Vory and the current app keep working until D. Each step is one tested commit
with its docs.

### A. Gateway: the new API

- [x] **A0 Contract.** Turn the Design section into `docs/API.md` (resources, events, ops, errors,
  evolution rules). Add an upstream test that pins what the turn shape relies on: tool results'
  `durationMs`/`isError`, message timestamps, and appending a bookkeeping entry when a run ends.
- [x] **A1 Foundation.** `src/server.ts` (move the listeners out of `hermes/`), `/api/v1` mount, Bearer
  auth, errors, the op table with HTTP and WebSocket dispatch, hello and features, the event envelope,
  `test/api/client.ts`. Tests: auth (401 and close 4401), unknown op, the same op over both transports.
- [x] **A2 Chat.** Bots (read), sessions (list, get, search, patch, delete, create), turns history,
  subscribe with snapshot, live turn and item events, submit, steer, interrupt, session settings,
  approvals (global events, answer from any socket), usage, context, commands and compact, models.
  Run-end bookkeeping entry. Tests mirror `test/hermes/protocol.test.ts`, plus: an approval answered on
  socket A is announced on socket B; a denied tool shows as a tool item that did not run; reply parts
  split by tool calls arrive as separate items; redaction of secrets in every new field (args, results,
  JSON results).
- [x] **A3 Attachments.** Binary upload, withdraw, the `attachments` table, content blocks in history,
  content download for every kind, the limits in the hello. Tests port `test/hermes/attachments.test.ts`,
  plus withdraw and download of a PDF from an older turn.
- [x] **A4 Federation and peers.** Members and `peer:` bots on the new socket; member access and
  forwarding from the op table; member bots' settings through `/federation/manage/*`; group chat turns of
  member bots; delegation to members, background delegation included. All `test/federation/` and
  `test/remote/` tests move over, including the security ones (a member cannot reach another member's
  chats, turn off approvals, or see private bots).
- [ ] **A5 Settings and maintenance.** Bot create, edit and remove; skills; rules; gateway settings;
  keys; MCP; jobs; logs; usage analytics; files; software and actions. Tests port `test/hermes/manage.test.ts`,
  `cron.test.ts`, `test/mcp/vory.test.ts`.
- [x] **A6 Group chats.** Rooms on the new API, with `room.event` pushed live. Tests port
  `test/hermes/groups.test.ts`.
- [ ] **A7 Fixtures and docs.** `scripts/api-fixtures.ts` runs a throwaway faux-model gateway and records
  real responses and event streams for the app's contract tests (nothing is written into the repo by
  `npm test`). `docs/OPERATIONS.md` (connecting a client), `ARCHITECTURE.md` (the boundary is
  `src/api/`), `docs/STATUS.md`.
- [ ] **A8 Replay on reconnect.** The per-chat event buffer and `afterSeq` (feature `events.replay`).
  Optional for the bar above; the snapshot keeps working without it.

### C. App: NHermesKit onto the new API

Work happens in the app repository, against a gateway built from phase A (the app's `TestServer`
pointed at a current gateway source). The app keeps building and working on both platforms after every
step.

- [ ] **C1 Transport.** `RESTClient` on `/api/v1` with Bearer auth and the error object;
  `GatewaySocket` with the new frames, hello, server pings and features; reconnect and backoff unchanged.
- [ ] **C2 Wire types.** Bot, Session, Turn and items, Approval, Job, Room, MCP and Usage types from
  `docs/API.md`, with tolerant enums. `ContractTests` read the fixtures from A7.
- [ ] **C3 Chat.** `ConversationStore` applies the turn and item events; history loads as turns.
  Deleted: `TranscriptBuilder`'s failure guessing, closing reply parts on `tool.start`, replacing the
  reply with `message.complete.text`, the `Failed:` prefix. "Worked 11s" and step durations come from the
  gateway, for history too.
- [ ] **C4 Approvals and change events.** Approvals from the global events; deleted: subscribing to every
  running chat to catch approvals, re-reading `approval.pending`. Lists update from the objects in change
  events instead of refetching.
- [ ] **C5 Attachments.** Binary uploads, withdraw on discard, any file opens from history. Deleted:
  `AttachmentMarks`, the `@file:` line in prompts.
- [ ] **C6 Everything else.** Bots with `node` (no name parsing), model picker with thinking levels, chat
  settings through `PATCH`, Scheduled on `/jobs`, MCP settings, search, commands, MacBridge cards from
  `result.json` where present (the text path stays for servers without it).
- [ ] **C7 Test harness and docs.** `TestServer` on the new API (its verify scripts too), the app's
  `README.md` and `docs/CAPABILITIES.md` rewritten, the limitations that no longer apply removed.
- [ ] **C8 Parity check.** The checklist below on the Mac and the iOS simulator against `TestServer`,
  then read-only against the owner's gateways.

### D. Delete the Hermes layer and Vory

- [ ] `src/hermes/` (all of it), `test/hermes/`, `src/federation/vory.ts`, the Vory Companion routes, the
  old socket for members, `scripts/vory-e2e.sh`, `docs/COMPATIBILITY.md` (replaced by `docs/API.md`).
- [ ] Hermes and Vory pins out of `UPSTREAM.md` and `scripts/fetch-upstream.sh`. What we ported keeps its
  credit: the room planner (`core/room-plan.ts`, MIT, a port of Hermes's `plan_next_task`) and anything
  else that still holds ported logic.
- [ ] Wording: the bots' `about` section and ground rules (`tools/self.ts`), panel text, doctor and keys
  messages, comments that cite Hermes or Vory shapes, `README.md`, `ARCHITECTURE.md`, `AGENTS.md`.
- [ ] `src/notify/vory.ts` stays (sender only) until E.

### E. Native push

- [ ] Gateway: devices, an APNs sender (token auth with a `.p8` key in `secrets.env`, sent straight to
  Apple; no relay), notification kinds and settings as `notify/vory.ts` has them today (approvals,
  finished and failed turns, scheduled results, the `notify` tool, a settled approval's banner replaced
  on other devices), approval actions. Federation's forwarding of notifications to the member that has a
  transport (`federation/notify.ts`) works with the new sender.
- [ ] App: registration, notification categories and actions, opening the chat or approval a
  notification is about.
- [ ] Then delete `src/notify/vory.ts`, its tests and the `<data>/vory` folder (see decision 5).

## Parity checklist

Checked at C8, and at D against the panel and CLI.

- **App:** bot list with member machines; open, rename, pin, archive, delete chats; archived chats;
  streaming with Markdown; activity timeline with durations, arguments and results; stop; queued
  messages; "Not confirmed" and retry without a double send; approvals inline, in Waiting for You, as
  notifications, answered on another device; split view; Quick Entry; model and reasoning picker;
  compact, usage, status; Scheduled with Run now, pause and resume; search; attachments (pictures,
  PDFs, files, paste, drag) and their previews in history; link chips; MacBridge cards; web page tiles;
  MCP settings; offline banner, reconnect, recovery after a gateway restart; deleted chats moving panes.
- **Network:** chats with a member's bot; its approvals asked here; member bot settings under the edit
  switch; delegation (waiting and background) to member and `peer:` bots, surviving restarts on either
  side; group chats with member bots; member MCP management; notifications sent once per phone.
- **Gateway:** panel, CLI, backup and restore, update from the panel and the CLI (an older install
  script still finds `/api/health`), scheduled jobs, bots' own tools (`self_*`, `schedule_*`, `notify`).
- **Security:** approvals enforced on the server; a member reaches only its own chats and shareable bots;
  delegation never raises privileges; secrets redacted in every new field; keys write-only.

## Decisions

Settled with the owner before A0.

1. **camelCase JSON and Unix-millisecond times.** Matches the panel, admin API and core; Swift decodes
   both without key strategies.
2. **Per-chat Bypass (YOLO) stays in memory** and resets when the gateway restarts, as today.
   It is a session setting (`PATCH /sessions/:id {yolo}`), separate from a bot's approval mode `off`.
3. **Tool results whole up to 64 KB** on the wire, with a fetch for anything longer.
4. **Work lands on `main` as local commits, step by step,** pushed when the owner says. Old and new APIs
   run side by side until D, so a push in between ships nothing broken.
5. **The Vory push folder** (`<data>/vory`, which holds relay registrations) is removed by a one-time
   cleanup at gateway start in phase E, and logged.
6. **Later, not in this plan:** moving the panel's own `/panel/api` onto `/api/v1`. The op table makes
   that possible, but the panel works today and has its own sign-in.

## Progress

- A0 `7e7093b`: conventions, errors, hello and the socket in `docs/API.md`; resource sections land with each
  step. Durable pins in `test/upstream/durable-contract.test.ts`.
- A1 `8f1d486`: `src/server.ts` and `src/http.ts` out of `src/hermes/`; `/api/v1` beside the Hermes API.
- A2 `0154841` (with `8499c75` for MCP structured results): chats, turns, live events, approvals, models.
  Chats with a member's bot answer `not_available` until A4.
- A3 `91ff5c6`: uploads by id (`attachments` table), withdraw, download, ids in history.
- A4 `79b7026`: `src/remote/api-client.ts`; peers, delegation and member bots' group chat turns on
  `/api/v1`; the app's chats with members' bots through `src/federation/chats.ts`. Members' bot settings move
  with A5 (through `/federation/manage/*`). The Hermes-only federation tests (Vory's proxy path, the member
  Hermes socket) stay until D.
