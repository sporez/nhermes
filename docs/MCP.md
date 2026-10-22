# MCP servers (plan)

Status: in progress.

## Steps

- [ ] M0. Upstream checks: `pi-mcp` as a direct dependency, contract tests for what we rely on
- [ ] M1. Connections: config, per-server lifecycle, health checks, backoff, tool snapshots
- [ ] M2. Tools: MCP tools in bots' tool groups, calls, outcomes, approvals, deferred exposure
- [ ] M3. Management: MCP tab in the panel, `nhermes mcp`, admin API, keys, doctor
- [ ] M4. Vory: `/api/mcp/servers` (list, per-bot toggle, test, remove)
- [ ] M5. Network: manage a member's MCP servers from any panel and from Vory
- [ ] Later: OAuth sign-in, stdio servers, the stateless 2026-07-28 protocol, resources

## Goal

Any Model Context Protocol server that speaks Streamable HTTP can give tools to the bots the owner
picks. A typical case is a macOS service that exposes Calendar, Reminders and Contacts and runs on a
laptop that is sometimes asleep or away. nHermes contains no code for any particular server. The
same design must hold for every compliant server.

Central rule: **an MCP server is an optional capability whose availability can change at any
moment.** A server that is down, slow or misbehaving never stops the gateway from starting, never
blocks another server, never stalls a bot that is not using it, and never makes a tool call look
successful when it was not.

## Where we start

- **Tools.** A bot's tools are the union of its tool groups (`tools:` in config.yaml,
  `src/tools/index.ts`). `agentFor` (`src/app.ts`) turns them into Durable tool registrations, and
  `Sessions.followBot` (`src/core/sessions.ts`) applies a bot's current tool list to each session
  before each prompt, matched by name. Built-in tools are installed once as the `tools` extension.
- **Pi Durable is ready for tools that come and go** (`reference/pi/packages/durable`):
  - `registry.install(extension)` replaces an installed extension in place at runtime. The tool-search
    description even says this happens "as MCP servers connect".
  - By default every installed extension is selected.
  - A tool that stops resolving is never a request failure. The next request appends a system delta
    with `toolsRemoved`. A call to it gets a `tool_unavailable` error result and the run continues
    (spec §7.3).
  - Tools can be `deferred` and loaded per chat by `tool_search`
    (`@earendil-works/pi-durable/tool-search`), which appends their declarations so the cached prompt
    prefix holds.
  - A tool is `replay: "unsafe"` unless declared safe. After a restart mid-call, the model gets an
    `interrupted` result instead of a rerun.
- **Pi has an MCP client:** `@earendil-works/pi-mcp` 1.2.0. It is already installed, as a dependency
  of `pi-coding-agent` from the same release.
  - Supported: `McpClient` (initialize, paginated `tools/list`, `tools/call`, progress with timeout
    renewal, cancellation, `ping`), `StreamableHttpTransport` (sessions, the optional GET stream with
    reconnect, `Last-Event-ID` resumption), `toLlmContent()`, typed errors (`McpError`,
    `McpTimeoutError`, `McpConnectionClosedError`, `McpHttpError`, `McpAuthRequiredError`,
    `McpSessionExpiredError`), an in-memory test transport, stdio and an OAuth module.
  - A POST that fails rejects only that request. The transport does not close, so availability has
    to be tracked by us.
  - It retries a request only after an auth provider refreshed credentials (we set none in v1), and
    never once the caller gave up.
- **Pi's coding agent has an MCP extension** (`coding-agent/src/extensions/mcp/`). It is written for
  pi-agent-core, not Durable, and is not exported, so we cannot use it directly. We follow its
  conventions where they fit:
  - tool names `mcp__<server>__<tool>`, at most 64 characters, with a hash suffix on collision;
  - a 60 s default call timeout;
  - per-tool exposure patterns;
  - tool calls are never retried; only read-only requests are retried, once.
- **Vory** has an MCP Servers screen (`HermesSettingsViews.swift`): `GET /api/mcp/servers?profile=`,
  `PUT …/{name}/enabled`, `POST …/{name}/test`, `DELETE …/{name}`. It cannot add a server. nHermes
  answers 404 today (`docs/COMPATIBILITY.md`).
- **Approvals.** `decide()` (`src/core/policy.ts`) classifies calls, and the `guard` hook
  (`src/agent/extensions.ts`) enforces them. Work a network member started (session source
  `member:<node>`) is never trusted and is not reviewed by Jev. Its asks are relayed to the owner
  through the member (`fromMachine` in `src/tools/delegate.ts` and `src/federation/proxy.ts`), and
  configuration changes are refused. Otherwise it runs under normal policy at the strictest mode in
  the chain.

## The MCP specification we build on

- **Current revision** is
  [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog). It is stateless:
  - no `initialize`;
  - no sessions;
  - no `ping`;
  - no GET stream (replaced by `subscriptions/listen`);
  - no stream resumption;
  - a new `server/discover`.
- **pi-mcp** (1.2.0, and still 1.4.0, released 2026-10-21) speaks the handshake-based
  [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25), and accepts 2025-06-18,
  2025-03-26 and 2024-11-05. The spec calls these revisions "legacy".
- **Era compatibility.** A "dual-era" server answers both kinds of client. A server that speaks only
  2026-07-28 rejects pi-mcp. v1 therefore supports **2025-11-25 and earlier, and dual-era servers.**
- **Requirement on the motivating server:** it speaks 2025-11-25 or is dual-era.
- **Modern-only servers** are reported in the panel as "needs a newer MCP protocol" (see Risks).

Requirements the spec imposes (2025-11-25) and that this plan follows:

| Spec rule | What we do |
|---|---|
| Lifecycle: `initialize`, then `notifications/initialized`; the client must not send other requests first | pi-mcp `connect()` |
| Session: a 404 for a request carrying `MCP-Session-Id` means the session is gone, and the client MUST start a new one | Re-initialize; resend only that one request, once (the server did not process it) |
| Timeouts: SHOULD set them on every request, send `notifications/cancelled` on timeout, MAY renew on progress, SHOULD keep a maximum | Per-call timeout renewed by progress, plus a hard maximum |
| Ping: SHOULD ping periodically to check health; frequency configurable; avoid excess; treat timeouts as failures | Idle health check, configurable per server |
| Cancellation does not undo: the server may already have done the work | A timed-out or cancelled call is reported as "may have run" |
| Tool errors: protocol errors are JSON-RPC errors; execution errors are `isError: true` results the model should see | Different outcomes, both shown to the model |
| Tool annotations MUST be treated as untrusted unless the server is trusted | Read-only comes from the owner. Trusting `readOnlyHint` is an explicit per-server choice |
| Security: show tool inputs before sensitive calls; treat results as untrusted; time out; log usage | Approval cards show the arguments, results are data, every call is logged without arguments |
| Client capabilities are opt-in | We declare none: no sampling, no elicitation, no roots |

Everything else below is an nHermes design choice.

## Decisions

1. **One generic client, at its own seam.** `src/mcp/` owns server connections, availability and
   tool snapshots. It does not import Durable. `src/tools/mcp.ts` turns snapshots into Durable tools,
   like the other tool modules. No server-specific code anywhere.
2. **Streamable HTTP first. stdio later.** The connection layer takes a pi-mcp `McpTransport`, so
   stdio is a later phase with its own process and environment rules, not a redesign.
3. **A server is a tool group.** Server `calendar` is group `mcp:calendar`. A bot gets it by listing
   it under `tools:`, exactly like `web` or `browser`, so the panel's bot editor, Vory's Tools page and
   members' bot edits work unchanged. No bot gets a server by default.
4. **Approvals.** An MCP call asks (Jev may answer in smart mode) unless the tool is read-only.
   - **Read-only comes from the owner:** a per-server `tools.readOnly` pattern list. Setting
     `trustReadOnlyHint: true` on a server also counts its tools' own `readOnlyHint`.
   - **Read-only tools** run without asking in smart mode and are `replay: "safe"`. Everything else
     is `replay: "unsafe"`.
   - **Manual mode** asks for every tool that is not read-only. **Off** allows everything except
     deny rules.
5. **New and changed tools apply automatically.** The MCP tab flags what changed and when.
   `tools.include`/`tools.exclude` pin exactly what is exposed.
6. **Plain `http://` to another machine is allowed with a warning** at load and in the panel, as
   peers are today (`cleartextRemote` in `src/config.ts`).
7. **Authentication in v1: headers from `secrets.env`.** `headers` values may contain
   `{{secret:NAME}}` (the `http_request` syntax). OAuth comes later; pi-mcp's OAuth module is the
   starting point.
8. **Network: per machine, plus remote management.**
   - A server belongs to the gateway that configures it. Only that gateway connects to it, and only
     its bots call it.
   - Other machines reach it by delegating to such a bot, the path that exists today.
   - Any panel (and Vory, for a member's profile) can manage a member's servers under that member's
     "Let other machines edit this machine's bots" switch. Key values never travel that way.
9. **Work another machine started** uses MCP tools exactly like other tools on that path, as
   described in "Where we start": never trusted, no Jev, asks relayed to the owner through the
   member. Nothing MCP-specific is added.
10. **Vory's screen:** the toggle grants or removes the selected bot's `mcp:<server>` group. Test
    runs a live check. Remove deletes the server from the gateway (Vory asks first).
11. **Exposure per server:**
    - `exposure: direct` (default): the tools are declared to the model.
    - `exposure: deferred`: the model finds them with `tool_search`, which loads them for that chat.
12. **A down server keeps its known tools declared, and calls fail fast.** See the next section.

## Down servers: keep their tools declared, or hide them?

**Decision: keep the last known tools of a server that has connected before declared while it is
offline. A call fails within a few seconds with an outcome that says "offline, not sent, nothing
changed".** Tools leave the declaration only on events that really change them:

- the server is disabled or removed;
- the bot no longer has the group;
- an include/exclude change;
- a fresh `tools/list` that no longer has the tool.

Why, in this runtime:

- **The model can say the right thing.** When the tools disappear, the model believes it never had
  calendar access and says "I can't do that". The owner wanted "your calendar is offline right now,
  try again when the laptop is awake". The structured failure gives that, and the requirement asks
  for it ("the agent should understand that a tool is temporarily unavailable").
- **No churn in every chat.** Each change to a conversation's tool set appends a system delta at its
  next request, in every session of every bot with the group. A laptop that sleeps nightly and drops
  Wi-Fi now and then would add deltas all day. Whether a removal also costs a provider cache miss
  depends on the provider's adapter (not verified). Stable tool sets avoid the question.
- **Calls are what bring the server back.** A call to an offline server first makes one short
  reconnect attempt. That catches a laptop that just woke before the backoff timer would. A hidden
  tool can never be called, so it cannot trigger that.
- **The cost is small.** At worst, one wasted call per question that needed the server, answered in
  milliseconds (or within the 3 s attempt).
- **Durable already handles the hiding cases** we keep (removed tools, stale calls) with
  `toolsRemoved` and `tool_unavailable`.

Rejected:

- **Hide while offline.** Above.
- **Put live availability in the prompt or the tool descriptions.** Every flip would rewrite text in
  every chat's prompt.
- **Hide after N days offline.** It adds a timer and a surprising disappearance. The panel shows
  "offline since …", and disabling the server is one click.

Never-connected servers have no definitions to declare. The bot's prompt names the server with
"no tools known yet", so the model can explain why it cannot help.

## Component architecture

```
config.yaml mcp.servers ──► McpServers (src/mcp/servers.ts) ── one McpConnection per server
                               │   status, snapshots (app.sqlite), change events
                               │
                               ├─► src/tools/mcp.ts: ToolRegistrations per snapshot, groups mcp:<name>,
                               │     the "mcp" Durable extension (re-installed on change),
                               │     tool_search when a granted server is deferred, the prompt part
                               ├─► core/policy.ts: read-only lookup for MCP tools
                               └─► panel / admin / hermes (Vory) / federation/manage routes (translate only)
McpConnection (src/mcp/connection.ts): one server's state machine over pi-mcp McpClient +
                               StreamableHttpTransport; backoff, health check, on-demand probe, discovery
src/mcp/outcome.ts: classifies every failure into an outcome (pure, unit-tested)
```

- **Startup.** `createCore` builds `McpServers` after the engine opens. It installs the `mcp`
  extension from the snapshots stored in `app.sqlite` and starts each connection in the background.
  Nothing awaits a server, so the gateway is up whatever the servers do.
- **Groups.** `toolGroups` gets `mcp:<name>` for every configured server, empty until a snapshot
  exists, so `Settings.check` accepts it. `agentFor` reads the groups at each prompt, so changes reach
  sessions through `followBot`.
- **Republishing.** When a snapshot or server config changes, `src/tools/mcp.ts` rebuilds that
  server's registrations and calls `engine.registry.install()` with the new `mcp` extension.
  Durable publishes synchronously, and the next request in each chat gets the delta.
- **Execution location.** MCP calls always go out from the gateway process, also for bots whose
  shell runs on an SSH host. The server has to be reachable from the gateway.
- **Shutdown.** `close()` stops all connections in parallel, bounded at 2 s. pi-mcp's session
  DELETE is best effort, 1 s.

## Connection lifecycle and availability

One `McpConnection` per server. Each has its own timers and its own client. No server waits on
another, and a call waits only on its own server.

| State | Meaning | Calls | Leaves when |
|---|---|---|---|
| `disabled` | `enabled: false` | not declared | enabled → `connecting` |
| `connecting` | initialize + `tools/list` in progress (bounded at 10 s) | wait for this attempt, bounded by the call's own probe budget | success → `online`. 401/403 → `needs_key`. Protocol or version error → `failed`. Anything else → `offline` |
| `online` | initialized, last request or health check succeeded | sent | 2 failed health checks, or a call outcome that shows the server is unreachable → `offline` (one immediate reconnect first). 401/403 → `needs_key` |
| `offline` | unreachable; the last snapshot is kept | one on-demand reconnect attempt (3 s budget, shared by concurrent calls, at most every 5 s), then fail fast | backoff timer, a call, or the panel's Test/Reconnect → `connecting` |
| `needs_key` | the server refused the gateway's credentials | fail fast: the owner must fix the key | the key or config changes, Test/Reconnect, or every 30 min → `connecting` |
| `failed` | misconfigured: unsupported protocol version, invalid initialize result, refused URL | fail fast with the reason | config change, Test/Reconnect, or every 30 min → `connecting` |

- **What counts as available.** Only `online` is available. A completed request proves the server
  was reachable then, nothing more. So:
  - while `online`, an idle health check (`ping`) runs every `healthCheckS` (default 60 s; 0 turns
    it off) with a 10 s timeout;
  - any successful request counts as a health check;
  - a call that ends in "lost" or "not sent" marks the server offline at once.
- **The GET stream is not a liveness signal.** Servers may refuse it (405), the transport gives up
  after 5 failed reopens, and 2026-07-28 removes it. It is used only for `list_changed`.
- **Backoff.** From `offline`: 5 s, doubling, capped at 5 min. Each wait is a random 50–100 % of the
  step. Success resets it. A laptop asleep overnight costs about 12 attempts an hour, each bounded
  at 10 s.
- **Logs.** One line per state change (`mcp: calendar offline (connect ECONNREFUSED); retrying with
  backoff`), plus one when it comes back with how long it was down. Repeated failures in the same
  state go to debug only.
- **Panel status:** state, since when, last error (redacted), last connected, next attempt, tool
  count, and whether the tools are fresh (this connection) or cached (earlier).

## Tool discovery, caching and invalidation

| Term | Meaning |
|---|---|
| configured | In `mcp.servers` (enabled or not) |
| available | State `online` |
| snapshot | The last successful `tools/list`: tools, schemas, annotations, server info, protocol version, time |
| fresh / cached | The snapshot came from the current connection / from an earlier one or from disk |

- **When we list tools.**
  - On every successful (re)connect, if the server declares the `tools` capability.
  - On `notifications/tools/list_changed`.
  - On the panel's Refresh.
  - No periodic polling. 2026-07-28's `ttlMs` would replace this when we support it.
- **Storage.** In `app.sqlite`, one row per server:
  - URL, time, server info, protocol version, tools as JSON;
  - plus a short change log (last 50 per server) of added, removed and changed tool names. A change
    is a different hash of name, title, description, schemas and annotations.
  - Forward migration under `schema_version` (`src/store/db.ts`).
- **Diff on each new snapshot.**
  - Added tools are declared.
  - Removed tools are dropped from the `mcp` extension (Durable sends `toolsRemoved`; a stale call
    gets `tool_unavailable`).
  - Changed tools are re-declared.
  - A rename is a removal plus an addition.
  - The panel flags each change.
  - Owner rules and "always" answers are keyed by tool name. They follow a rename only if the owner
    renames them.
- **Invalidation.** A changed URL means a different server, so the snapshot is dropped. Removing a
  server deletes its rows. A failed list keeps the previous snapshot and reports the error.
- **Never connected:** no snapshot, no tools, prompt line "no tools known yet".
- **Agent context.** One prompt part per bot lists its granted servers. It says each server's
  owner-written `description` and, for deferred servers, "find its tools with tool_search". It
  carries no live status, so it changes only when the owner changes config. The server's own
  `instructions` from `initialize` are not put in the prompt (untrusted text). The panel shows them.
- **Limits.**
  - Tool descriptions are cut at 2,000 characters.
  - A server with more than 100 exposed direct tools gets a warning in the panel suggesting
    `deferred` or `tools.include`.
- **Schemas.** MCP `inputSchema` goes to Durable as the tool's parameters, made an `object` with
  `properties` (some providers require both), as Pi's coding agent does. pi-ai validates arbitrary
  JSON Schema and coerces where it can. M0 tests this against schemas with `$ref`, `$defs` and
  `oneOf`.

## Tool invocation and outcomes

- **Names:** `mcp__<server>__<tool>`, characters outside `[A-Za-z0-9_]` become `_`, at most 64
  characters, with an 8-hex hash suffix when it is too long or collides (Pi's rule).
- **A call:**
  - the guard (approvals) runs first;
  - then `McpConnection.call()`, which applies the state table above;
  - then `client.callTool(name, args, { signal, timeoutMs, onProgress })`;
  - progress messages stream through `api.output()`.
- **Results:** `toLlmContent()` (text, images; resources and links as short text), capped at 20 KB
  of text (middle cut, as Pi does). `structuredContent` without content blocks becomes JSON.
- **Every failure returns an `isError` result** with a plain sentence for the model, and
  `details: { server, tool, outcome, sent, ms, httpStatus?, rpcCode? }` for the panel and logs. No
  failure is ever reported as success.

| Outcome | When | Did it run? | The model is told (shortened) |
|---|---|---|---|
| `offline` | Not connected and the on-demand attempt failed | No, never sent | "calendar is offline (unreachable since 21:04). The call was not sent; nothing changed." |
| `not_sent` | Connection refused, DNS failure, host unreachable or connect timeout when sending | No | Same as offline. The server becomes `offline` |
| `auth` | HTTP 401/403 | No | "calendar refused the gateway's key; nothing changed. The owner needs to update it." → `needs_key` |
| `rejected` | HTTP 429 or 400; JSON-RPC −32600/−32601/−32602 | No | The server's reason |
| `tool_error` | Result with `isError: true` | The server ran it and reports failure | The server's content, unchanged |
| `server_error` | Any other JSON-RPC error, or HTTP 5xx | Unknown | "calendar reported an error: …. It may have partly run; check before repeating it." |
| `lost` | Connection dropped, or the stream ended, after the request was sent | Unknown | "The connection dropped after the call was sent. It may or may not have run. Don't repeat it blindly: check with a read-only tool or ask the owner." |
| `timeout` | No answer within the timeout | Unknown (a cancel was sent; the server may still finish) | "No answer within 60 s. A cancel was sent, but it may still have run. Check before repeating." |
| `cancelled` | The owner interrupted after sending | Unknown | Durable's aborted result; a cancel was sent |
| `invalid_result` | The answer is not a valid tool result | Unknown | "calendar answered with something nHermes could not read; it may have run." |

- **Read-only tools** (by the owner's mark) get "nothing changed either way; you may try again" in
  place of the "may have run" warnings.
- **The four "did it run?" columns** (no / ran / unknown) come straight from the spec. A JSON-RPC
  error or a 401/403/429 is the server refusing the request. A 404 on a session is spec-defined. A
  network error before any byte was sent is definite. Everything after sending without a result is
  unknown.

## Retries, timeouts and recovery

| What | Rule |
|---|---|
| `tools/call` | **Never retried**, with one exception: after a 404 session expiry the same request goes once on a new session, since the spec says the server did not process it. No queue, and nothing is replayed after a reconnect |
| Unknown outcome | Reported as unknown. The model decides, usually by checking with a read-only tool or asking the owner |
| Read-only requests (`tools/list`, `ping`) | Retried only through the reconnect loop |
| Call timeout | `timeoutS` (default 60), renewed by progress, never past `maxTimeoutS` (default 300). On expiry pi-mcp sends `notifications/cancelled`, and the result is `timeout` |
| Owner interrupt | The Durable abort signal reaches the call. A cancel is sent if it was already sent |
| Connect attempt | Initialize + list bounded at 10 s; on timeout the attempt's client is closed, which aborts its fetches |
| On-demand probe | One attempt, 3 s budget, shared by concurrent calls, at most every 5 s |
| Health check | `ping` every `healthCheckS` while idle and online; 10 s timeout; 2 misses → offline |
| Backoff | 5 s doubling to 5 min, 50–100 % jitter; 30 min for `needs_key`/`failed`; a config or key change retries at once |
| Gateway restart mid-call | Durable rule: `unsafe` tools are not rerun, and the model gets `interrupted`. Read-only tools (`replay: "safe"`) rerun |
| Redirects | Refused (`redirect: "error"` in the injected fetch), so headers never follow a redirect to another origin |

Exactly-once is not claimed, as for jobs (`ARCHITECTURE.md`, Scheduling): neither the protocol nor
the server gives an idempotency key.

## Authentication and authorization

- **Server credentials.**
  - Header values in config may contain `{{secret:NAME}}`. NAME must be set in `secrets.env`
    (managed write-only in the Keys tab and `nhermes secret`).
  - Secrets (`src/core/secrets.ts`) lists the name as "used by mcp:calendar".
  - Values are registered for log redaction at load and on change. A change reconnects the server.
  - Values are never returned by the panel, admin API, Vory routes or `/federation/*`. Only names are.
  - Bot shells never inherit them (`secretEnvNames`).
- **Transport.** `https`, or `http` with a warning when it goes to another machine (decision 6).
  - The server URL comes only from the owner (config, panel, CLI, or a member under the edit
    switch), never from a model.
  - URLs on this gateway's own ports on this machine are refused, extending `isOwnPanel` in
    `src/tools/own-gateway.ts` to any path.
- **Which bots.** The `mcp:<server>` group (decision 3). The server's `tools.include`/`exclude`
  narrows what any bot sees.
- **Which calls ask.** `decide()` gets a read-only lookup for MCP tools:
  - read-only: allowed in smart mode;
  - not read-only: a `tool:mcp__…` reason, reviewable by Jev in smart mode, always asked in manual
    mode;
  - owner `ask`/`deny`/`allow` rules work as today, with `tool:` rules gaining `*` patterns
    (`tool:mcp__calendar__delete_*`);
  - "always" answers are per tool;
  - the approval card shows server, tool and arguments (clipped);
  - jobs use the job's `approvals: deny|allow`;
  - delegation keeps the strictest mode in the chain;
  - work from another machine is described in "Where we start".
- **Untrusted content.**
  - Results, tool descriptions, schemas, server instructions and error bodies are data. They never
    change policy (existing rule).
  - Results pass the guard's secret redaction.
  - We declare no client capabilities, so a server cannot ask the gateway to sample a model, show a
    form or list files.

## Network (federation)

- **Ownership.** A gateway owns its servers: config, keys, connections, snapshots, status. MCP
  traffic leaves only that gateway.
- **Members' bots.** The roster does not change. A `<bot>-<node>` reached by delegation runs on its
  own machine with that machine's MCP tools. A remote bot has no tools on the calling gateway
  (`src/core/bots.ts`).
- **Remote management** (M5) is under the existing switch "Let other machines edit this machine's
  bots":
  - The owning gateway serves `/federation/manage/mcp/*` (list with status, add, edit, enable,
    disable, remove, test, refresh, tools), with the same calls its own panel uses.
  - A panel reaches it through `/panel/api/remote/<node>/mcp/*`.
  - Granting a bot a server already works remotely, since `tools` is in `MEMBER_BOT_KEYS`.
  - Header values never travel. A member sets the secret name. The value is set on the owning
    machine, or copied with the existing key copy, under its own "accept keys" switch.
- **Vory with a member's profile** (`src/federation/vory.ts`): reads always, changes under the same
  switch, as for its other settings screens.
- **Not in scope:** calling a member's MCP tools without delegation. It would be a second execution
  path past the owner's approvals on that machine.

## Configuration

```yaml
mcp:
  servers:
    calendar:                       # [a-z0-9][a-z0-9-]{0,30}; group mcp:calendar
      url: https://mac.example.com:8443/mcp
      description: Calendar, reminders and contacts on the owner's laptop   # owner-written; prompt and panel
      enabled: true                 # default true
      headers:
        Authorization: "Bearer {{secret:CALENDAR_MCP_TOKEN}}"
      exposure: direct              # direct | deferred
      timeoutS: 60
      maxTimeoutS: 300
      healthCheckS: 60              # 0 turns the idle check off
      tools:
        include: ["*"]              # patterns; default all
        exclude: []
        readOnly: ["list_*", "get_*", "search_*"]
      trustReadOnlyHint: false
bots:
  - name: helper
    tools: [memory, web, mcp:calendar]
```

- **Parsing:** `src/config.ts`.
- **Writes:** `Settings` (`addMcpServer`, `editMcpServer`, `removeMcpServer`), through the YAML
  document so comments survive, checked by loading before replacing.
- **Applies live:** changed servers reconnect, removed ones close. No restart.
- **Removing a server** also removes `mcp:<name>` from every bot in the same write, so config.yaml
  stays loadable.
- **Unknown groups.** A bot that lists `mcp:<name>` for a server that does not exist is a config
  error at edit time. At startup it is a warning and is ignored, so MCP can never stop the gateway
  from starting.

## Panel, CLI, admin API, Vory

- **Panel: a new MCP tab** (`src/panel/static/mcp.js`, routes in `src/panel/panel.ts`).
  - The server list shows state badge, since when, URL, which bots have it, and tool count
    (fresh/cached).
  - Add/edit form. Header values are picked from Keys or set write-only there.
  - Actions: Test, Reconnect, Refresh tools, Enable/Disable, Remove (asked in the page).
  - Per-server tool list: read-only mark (owner or hint), exposure, full description, schema, and
    the change log.
  - A "Members' servers" section when a member allows edits.
  - Light and dark mode checked with `scripts/panel-dev.ts` plus a fake MCP server.
- **CLI:** `nhermes mcp list | show <name> | add <name> --url … [--header K=V] [--description …] |
  edit <name> … | remove <name> | enable <name> | disable <name> | test <name> | refresh <name> |
  tools <name>`, over `/admin/mcp/*`. Secret values use the existing `nhermes secret set`.
- **Vory:** `/api/mcp/servers` for a profile.
  - List: `name`, `transport: "http"`, `url`, `enabled` (= this bot has the group), plus `state` and
    `tool_count` (Vory ignores fields it doesn't know).
  - Toggle → `Settings.editBot` adds or removes the group.
  - Test → a live check `{ ok, status, tool_count, tools, error }`.
  - Remove → deletes the server.
  - Recorded in `docs/COMPATIBILITY.md`.
- **Doctor:** each server's state and last error.

## Testing

- **Test server.** A controllable Streamable HTTP MCP server in `test/mcp/server.ts`, on `node:http`
  and port 0.
  - Speaks: `initialize` with a session id, `tools/list` with pages, `tools/call`, `ping`, the GET
    stream with `list_changed`, DELETE.
  - Controls: stop and restart on the same port, require a bearer token, expire the session, change
    the tool list (and notify), and per-tool behaviour (answer, delay, never answer, drop the
    connection after receiving, `isError`, JSON-RPC error).
  - Counts every call it received, to prove nothing was retried or replayed.
- **Harness.** The faux model scripts the tool calls, through `testCore` and `test/helpers.ts`.
  Tests wait on real events (state-change events, the server's own signals), never sleeps.
  Backoff and health-check clocks are injectable, the way `Members` takes a clock.

| # | Scenario | Test |
|---|---|---|
| 1 | Connect, discover, call | Bot with `mcp:x` calls a tool; result reaches the transcript; server saw one call |
| 2 | Down at startup | `createCore` resolves with the server down; other bots answer; state `offline`; cached tools declared from `app.sqlite` |
| 3 | Goes down while running | Health check misses → `offline` once (one log line); calls answer `offline` without a request |
| 4 | Drops during a call | `lost` (unknown), not success; server counted one call; no retry |
| 5 | Comes back | Backoff (injected clock) → `online`; also the on-demand probe after "wake" |
| 6 | Tools change on reconnect | Added, removed and changed tools reach the next request; stale call gets `tool_unavailable`; change log row |
| 7 | Two servers, one offline | The other server's calls and other bots are unaffected, while one server hangs |
| 8 | Wrong key | 401 → `needs_key`, `auth` outcome, no retry storm; fixing the secret reconnects |
| 9 | Timeout on a write | `timeout`, "may have run", cancel received by the server, call count 1, nothing replayed on reconnect; read-only tool gets the "try again" text |
| 10 | Network | Delegation from a member runs the tool on the owning gateway; a write's ask reaches the owner through the member; `/federation/manage/mcp` refused with the switch off; no header value in any response |

- **Also tested:**
  - policy (read-only lookup, glob rules, manual and off modes, jobs);
  - outcome classification (pure);
  - naming and collision suffix;
  - secret redaction in results and errors;
  - URL refusal for the gateway's own ports;
  - Settings writes (remove strips groups);
  - restart mid-call (unsafe → `interrupted`, safe → rerun);
  - deferred exposure with `tool_search`;
  - Vory routes in `test/hermes/`.
- **Upstream contract tests** in `test/upstream/mcp-contract.test.ts`:
  - pi-mcp error types for refused, reset and timed-out requests;
  - no retry on POST;
  - session-expiry behaviour;
  - Durable `registry.install` republishing with a live conversation;
  - schema validation of `$ref`/`$defs`/`oneOf` schemas.
  - Run first after every Pi bump.
- **Never against a deployed gateway.** Live checks against a real server are opt-in, on a gateway
  the owner names.

## Phases

Each item is one or more tested commits with their docs.

- **M0. Upstream checks.**
  - Add `@earendil-works/pi-mcp` 1.2.0 (exact) as a direct dependency. It is already in the tree at
    that version.
  - `UPSTREAM.md`: six `@earendil-works` packages from one release.
  - The contract tests above.
- **M1. Connections.**
  - Config parsing and `Settings` writes.
  - `src/mcp/` (connection, servers, outcome) and the migration.
  - The test server.
  - Lifecycle tests 2, 3, 5, 7, 8 without tools.
  - Docs: `ARCHITECTURE.md` (new MCP section, data owners), `docs/STATUS.md`.
- **M2. Tools.**
  - `src/tools/mcp.ts`: groups, registrations, republishing, the prompt part, deferred with
    `tool_search`.
  - Policy and guard additions.
  - Tests 1, 4, 6, 9 plus policy and restart.
  - Docs: `ARCHITECTURE.md` tools table, `docs/OPERATIONS.md` (config).
- **M3. Management.**
  - MCP tab, `nhermes mcp`, `/admin/mcp/*`, the Secrets catalogue, doctor.
  - Panel checked light and dark with panel-dev.
  - Docs: `docs/OPERATIONS.md`.
- **M4. Vory.** `/api/mcp/servers`, tests, `docs/COMPATIBILITY.md`.
- **M5. Network.**
  - `/federation/manage/mcp/*`, the panel's members' section, Vory for members' profiles.
  - Test 10.
  - Docs: `docs/FEDERATION.md` or `docs/REMOTE-BOT-EDITS.md`.
- **Later.** Deferred until asked:
  - OAuth (pi-mcp/oauth, a panel flow like Logins);
  - stdio servers (a child process with a scrubbed environment);
  - 2026-07-28 once Pi supports it;
  - `resources/*` tools.

Size check: no touched file is near 800 lines today (largest: `src/hermes/ws.ts` at 615, not
touched). New code goes in new files at its own seam.

## Risks and trade-offs

- **pi-mcp speaks only the legacy protocol.** Modern-only servers fail with a clear `failed` state.
  When Pi adds 2026-07-28, three things change:
  - The health check becomes `server/discover`.
  - `list_changed` comes from `subscriptions/listen`.
  - The spec says a broken response stream loses the request and the client MUST re-issue it with a
    new id. For tools that are not read-only that conflicts with "no automatic retries of uncertain
    writes". Plan then: re-issue only read-only requests, report the rest as `lost` and record the
    deviation in `docs/COMPATIBILITY.md`.
- **Cached tools while offline** cost an occasional failed call and up to 3 s of probing (see the
  section above).
- **Tool descriptions are untrusted text in the model's tool list** (tool poisoning).
  - The server is the owner's choice. `tools.include` pins the tool set. Changes are flagged.
  - Descriptions are cut at 2,000 characters.
  - The server's instructions stay out of the prompt.
- **Remote management lets a member point this gateway at any URL**, including addresses on its own
  network, under the edit switch. The switch already allows granting shell and `trusted` remotely,
  so this is consistent (settled in review).
- **Arbitrary JSON Schema.** pi-ai validates and coerces, but unusual schemas may be stricter or
  looser than the server expects. M0 tests the common shapes, and a server's schema error shows in
  the panel.
- **Vory's Remove sits on a per-profile screen but removes the server for the whole gateway.** Vory
  asks first, and the panel and the docs say so.
- **The gateway's own network position decides reachability.** A bot on an SSH host still calls MCP
  from the gateway.

## Settled in review

1. **Trusted bots** do not skip the ask for MCP tools that are not read-only; an allow rule does that.
2. **Remote URLs:** a member may set or change a server's URL, under the edit switch.
3. **Defaults:** call timeout 60 s, hard maximum 300 s, health check every 60 s, backoff cap 5 min,
   probe budget 3 s.
4. **Long outages:** no expiry; an offline server keeps its tools declared until the owner acts.
5. **Jev** may answer asks for MCP tools that are not read-only, like other reviewable asks.

## Progress

- 2026-10-21: plan written from the code, Pi Durable 1.2.0, pi-mcp 1.2.0/1.4.0 and the MCP
  2025-11-25 and 2026-07-28 specifications. Not started.
