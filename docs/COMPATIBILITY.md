# Hermes / Vory compatibility

Target client: **Vory** at `d99369bf` (see `UPSTREAM.md`). Reference server: Hermes at `300228d2`.
Payload shapes follow Hermes's generated contract (`apps/shared/src/gateway-contract.generated.ts`)
restricted to the fields Vory decodes (`VoryCore/Models/WireTypes.swift`).

Status legend:

- **Tested**: implemented, covered by our automated tests, and checked with the Vory client where noted.
- **Partial**: works for the main path; limitations in Notes.
- **Gated**: not implemented; the client is told so through its own capability checks (error -32601,
  HTTP 404, empty capability list) and hides or degrades the feature.
- **Deferred**: not implemented and not gated; the client may show an error if the user opens it.
- **Future**: not implemented yet, but planned (gated or deferred until then).

"Verified with Vory" lists what has been exercised with the real app or Vory's own test suite
(`VoryTests/GatewayIntegrationTests.swift`), as distinct from our own tests.

## Vory's own test suites against this gateway

Run with `scripts/vory-e2e.sh` (stock Vory at the pinned commit, a dedicated simulator, a real model).

| Suite / test | Result | Notes |
|---|---|---|
| `VoryTests/GatewayIntegrationTests/testConnectionPassesAllLegs` | Pass | |
| `…/restEndpointsAnswerJSON` | Pass | |
| `…/websocketStreamsATurn` | Pass | real model (cerebras/gpt-oss-120b) |
| `…/cleansUpLeftoverE2ESessions` | Pass | |
| `…/aTurnSentFromOneDeviceShowsOnTheOther` | Pass | needed `message.start` at prompt acceptance, as Hermes does |
| `…/anApprovalAnsweredOnOneDeviceLeavesTheOther` | Not exercised | returns early unless the token is `mock-token` (scripted mock turns); covered by our `test/hermes/protocol.test.ts` |
| `…/aChatMovesToAProjectAndOut` | Not exercised | mock-only, and Projects are gated |
| `VoryUITests/VoryUITests/testOnboardingConnectChatAndSettings` | Pass | Full UI: add gateway, connection test, new chat, real reply, Tools/Config/Env pages. On a fresh simulator the first run stops at Vory's one-time Companion prompt, which the test does not dismiss (a Vory test issue, the same against Hermes); the second run passes |

## Connection and auth

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| Liveness + auth shape | `GET /api/status` | Tested | E2E `testConnectionPassesAllLegs`; UI onboarding | `auth_required: false`, `version`, `gateway_running`, `active_sessions` |
| Session-token auth | `X-Hermes-Session-Token`, `?token=` | Tested | E2E, UI onboarding | Wrong token: HTTP 401, WS close 4401 |
| Password / OAuth native sign-in | `/auth/native/*`, `/api/auth/*` | Gated | | `auth_providers: []`; Vory's session-token mode is used |
| Socket handshake | `/api/ws` → `gateway.ready` | Tested | E2E `testConnectionPassesAllLegs` | Payload `{skin:{}, change_events, heartbeat, replay_epoch}` |
| Heartbeat | `ping` | Tested | E2E `websocketStreamsATurn` | `{pong: true}` |
| Server-request capability | `client.capabilities` | Tested | E2E `websocketStreamsATurn` | Returns `["approval"]` only |
| Gateway capabilities | `gateway.capabilities` | Tested | | `per_session_exclusive_submit: true` |

## Bots (profiles)

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List bots | `GET /api/profiles`, `profiles.list` | Tested | E2E `restEndpointsAnswerJSON`; UI | One profile per bot, `is_default` for the primary bot |
| Active bot | `GET /api/profiles/active` | Tested | | |
| Bot instructions | `GET/PUT /api/profiles/{name}/soul` | Tested | | SOUL = bot instructions |
| Bot description / model | `PUT /api/profiles/{name}/description`, `/model` | Partial | | Description and default model persist as bot overrides |
| Profile home | `config.get {key:"profile"}` | Tested | | Bot workspace path |
| Create / delete bots | `POST /api/profiles` `{name, clone_from?}`, `DELETE /api/profiles/{name}` | Tested | | Adds or removes the bot in config.yaml, as the panel does. `clone_from` copies the other bot's settings and instructions (not its name, default flag, workspace or chats). Delete keeps the bot's chats, memory and workspace on disk; the default bot cannot be deleted. Renaming is not offered by Vory |
| Network members' bots | `GET /api/profiles`, `profiles.list`, `session.create` | Tested (protocol) | not yet in the Vory UI | Listed as `<bot>-<node>`, display name `Name (node)`; chats run on the member through this gateway (`docs/FEDERATION.md` F5). Its Tools, Skills, Config, instructions, description, model and usage go over the member link to its machine, which answers with its own handlers (`src/federation/vory.ts`): reads always, changes only when that machine allows bot edits from members (its panel: Network), else 403 saying so |

## Sessions and chat

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List sessions | `GET /api/sessions?order=recent&limit=&profile=` | Tested | E2E, UI chat list | Rows: `id,title,preview,source,model,started_at,last_active,message_count,is_active,archived,pinned,profile` |
| One session | `GET /api/sessions/{id}?profile=` | Tested | | 404 when another bot owns it |
| Messages page | `GET /api/sessions/{id}/messages` | Tested | | |
| Rename / pin / archive | `PATCH /api/sessions/{id}`, `session.title` | Partial | | `title`, `pinned`, `archived` work; `hidden` and `unread` are accepted and ignored |
| Delete | `DELETE /api/sessions/{id}`, `session.delete` | Tested | E2E cleanup test | Bot identity and memory untouched |
| Search | `GET /api/sessions/search?q=` | Partial | | Title and preview match only (no transcript full-text yet) |
| Create | `session.create` | Tested | E2E, UI new chat | Vory does not create jobs; the agent's `schedule_create` tool and the REST/CLI do |
| Resume snapshot | `session.resume` | Tested | E2E two-device test | `messages`, `running`, `inflight`, `turn_started_at`, `open_requests`, `info` |
| Close | `session.close` | Tested | | Detaches the socket; the run continues |
| Send prompt | `prompt.submit` | Tested | E2E, UI composer | `status: streaming`; while busy: `queued` (Durable follow-up) |
| Steer | `session.steer` | Partial | | Durable `whenBusy: steer`: placed after the current tool round |
| Stop | `session.interrupt` | Tested | | Durable `abort()` |
| Streaming | `message.start`, `message.delta`, `reasoning.delta`, `message.complete` | Tested | E2E (real model), UI shows reply | `message.complete.text` is the whole run's text |
| Tool events | `tool.start`, `tool.complete` | Tested | | `tool_id` = Durable tool call id |
| Usage | `session.usage`, `session.usage` event | Tested | E2E | From Durable `pi.usage` |
| Context breakdown | `session.context_breakdown` | Tested | E2E | System / tools / conversation estimate |
| Title | `session.title` event | Tested | | First prompt, shortened |
| Multi-device fan-out | events to every attached socket | Tested | E2E `aTurnSentFromOneDeviceShowsOnTheOther` | |
| Reconnect during a run | `session.resume` mid-run | Tested | | Snapshot, then live events |
| Attachments | `image.attach_bytes`, `pdf.attach`, `file.attach` | Deferred | | |

## Tools and approvals

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| Approval request | server→client `approval` | Tested | | Enforced by a Durable `beforeTool` hook |
| Answer approval | response frame, `approval.respond` | Tested | | `once`, `session`, `always`, `deny` |
| Pending approvals | `approval.pending`, `approval.received` | Tested | | |
| Withdrawn request | `request.cancel` event | Tested | | On interrupt / timeout |
| Clarify / sudo / secret / vault prompts | server→client | Gated | | Not in `client.capabilities` result |
| Per-session YOLO | `config.set yolo` | Partial | | Allows everything except deny rules; held in memory, so it resets on gateway restart |
| Toolsets | `GET /api/tools/toolsets`, `PUT /api/tools/toolsets/{name}` `{enabled}` | Tested | E2E, UI Tools page | One row per tool group; a toggle writes the selected bot's `tools:` in config.yaml |

## Models

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| Model options | `GET /api/model/options?profile=` | Tested | E2E `restEndpointsAnswerJSON` | From Pi `ModelRuntime`; `authenticated` per provider |
| Session model switch | `config.set model "<m> --provider <p> --session"` | Tested | | Durable `configure({model})` |
| Reasoning effort | `config.set reasoning` | Tested | | Durable `thinkingLevel` |
| Fast mode | `config.set fast` | Gated | | Accepted and reported as unsupported |
| Default model of a bot | `PUT /api/profiles/{name}/model`, `POST /api/model/set` `{scope:"main"}` | Partial | | Persists as a bot override; existing sessions keep their own model |
| Auxiliary models | `GET /api/model/auxiliary`, `POST /api/model/set` `{scope:"auxiliary"}` | Gated | | 404 / 400: the Jev reviewer's model is fixed, nothing else is auxiliary |

## Skills, config, status

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List skills | `GET /api/skills?profile=` | Tested | | `enabled` = active for that bot; per-bot skills are always listed, global ones when opted in |
| Toggle skill | `PUT /api/skills/toggle` | Tested | | Stored as a bot override |
| Slash command catalog | `commands.catalog` | Tested | E2E | Built-ins we really run + skills |
| Slash execution | `slash.exec`, `command.dispatch` | Partial | | `/compact`, `/usage`, `/status`; others return error 4018 |
| Config read | `GET /api/config?profile=`, `/api/config/schema` | Tested | E2E, UI Config page | The selected bot's model, approval mode, reasoning and "always allowed" rules (`command_allowlist`); the approval timeout and time zone are gateway-wide. `dashboard.ws_orphan_reap_grace_s` reads 0: nHermes never stops a turn because the app left |
| Config write | `PUT /api/config?profile=` `{config:{…}}` | Tested | | Model and reasoning as bot overrides; approval mode in the bot's config.yaml entry; timeout and time zone in config.yaml (after a restart); `command_allowlist` adds and removes the bot's rules. Any other key, or a nonzero away grace, answers 400 with the reason |
| Env / keys | `GET /api/env`, `PUT /api/env` `{key,value}`, `DELETE /api/env` `{key}` | Tested | E2E, UI Env page | Redacted, write-only, into secrets.env as the panel's Keys tab does; gateway-wide, not per bot. The gateway token is refused (403): it is changed in the panel or with `nhermes` |
| MCP servers | `/api/mcp/servers` | Future | | Not supported yet; may come later. 404 meanwhile |
| Logs | `GET /api/logs?lines=` | Tested | | The last 500 log lines this process wrote, as `YYYY-MM-DD HH:MM:SS LEVEL [scope] message`; older ones are in the journal / launchd log |
| Channels | `GET /api/messaging/platforms` | Gated | | 404: nHermes has no messaging platforms |

## Scheduled tasks

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List jobs | `GET /api/cron/jobs` | Tested | | All bots by default, `?profile=` filters |
| One job / runs | `GET /api/cron/jobs/{id}`, `/runs` | Tested | | `/runs` returns `{runs:[{run_id,status,trigger,started_at,finished_at,summary,error}]}` |
| Edit | `PUT /api/cron/jobs/{id}` `{updates}` | Tested | | `{updates:{…}}`; unknown/read-only keys from Vory's raw editor are ignored; invalid schedule → 400. `context: fresh|continue` (also in the job's shape) chooses a fresh context per run or one thread across runs |
| Pause / resume | `POST .../pause`, `.../resume` | Tested | | Resume computes the next run from now (no catch-up of paused time) |
| Run now | `POST .../trigger` | Tested | | Held up to 25 s, then answers with `state: running`; 409 while a run is going |
| Delete | `DELETE /api/cron/jobs/{id}` | Tested | E2E cleanup test | |
| Create | `POST /api/cron/jobs` | Tested | E2E, UI new chat | Vory does not create jobs; the agent's `schedule_create` tool and the REST/CLI do |
| Change notice | `cron.changed` event | Tested | | Sent on every job or run change |

## Other Vory features

| Feature | How Vory probes it | Status | Notes |
|---|---|---|---|
| Projects | `projects.list` / `projects.tree` | Gated | -32601 |
| Kanban board | `/api/plugins/kanban/*` | Gated | 404 |
| Bot rooms (groups) | `groups.capabilities` | Future | -32601 → Bot Mode hidden. Planned; group chats between bots are not built yet |
| Gateway voice (STT/TTS) | `/api/audio/*` | Gated | 404; Vory's on-device voice works |
| Files browser | `GET /api/files?path=`, `GET /api/files/download?path=` | Tested | Read-only. `/` lists each local bot's workspace; inside them, folders and files with sizes and dates; downloads up to 50 MB. Anything outside the workspaces, through `..` or a link, answers 403; uploads (`/api/files/upload-stream`) answer 403 |
| Analytics | `GET /api/analytics/usage?days=&profile=` | Tested | Dashboard, widgets, watch. Per bot: daily tokens, cost, chats and model calls, totals and a per-model breakdown, from every model call in that bot's chats (deleted chats drop out). Each chat is read once and again only when it changed |
| Notifications (Companion) | `/api/files/upload`, `/api/files/read`, `DELETE /api/files`, `/api/dashboard/agent-plugins/vory-push/{enable,disable}`, `push/status.json` | Tested (protocol) | Through the Vory push relay only, as its Companion plugin does (`src/notify/vory.ts`): approvals, finished and failed turns, scheduled-task results and the `notify` tool; a settled approval's banner is replaced on the other devices; the turn's Live Activity is finished. In a network, the gateway Vory is connected to notifies for its chats with members' bots too, and a member skips chats another gateway drives (`member:` source), so a phone set up on both gets each once. Installing the Companion in Vory stores its files (never run); the files API takes only those paths under a bot's home and keeps them in `<data>/vory`. Not sent: Live Activity progress, push-to-start, watch complications, clarify questions |
| Update, restart | `GET /api/hermes/update/check?force=`, `POST /api/hermes/update`, `POST /api/gateway/restart`, `GET /api/actions/{hermes-update,gateway-restart}/status` | Tested | The same update service as `nhermes update` and the panel: check lists the new commits, update fast-forwards and restarts. The action is "running" until the restarted gateway answers, then done. A gateway not run by systemd or launchd reports `can_apply: false` and refuses restart (409) with the reason. Rollback stays in the panel and CLI |
| Doctor | `POST /api/ops/doctor`, `GET /api/actions/doctor/status` | Tested | Config loads, each bot's model and its key, keys in use but unset, network members, SSH hosts (port reachable), disk space, failing scheduled tasks, Jev review, software and restart support. One line each, ✓ / ! / ✗; exit code 1 on any ✗ |
| Plugins hub | `/api/dashboard/plugins/hub` | Gated | 404; nHermes has no plugins |

## Cadu

Secondary target, not evaluated yet.
