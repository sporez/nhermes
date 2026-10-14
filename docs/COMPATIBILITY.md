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
| Bot description / model | `PUT /api/profiles/{name}/description`, `/model` | Partial | | Description and default model persist as bot overrides; create/delete bots is CLI-only |
| Profile home | `config.get {key:"profile"}` | Tested | | Bot workspace path |
| Create / delete / rename bots | `POST/DELETE/PATCH /api/profiles` | Deferred | | CLI manages bots |
| Network members' bots | `GET /api/profiles`, `profiles.list`, `session.create` | Tested (protocol) | not yet in the Vory UI | Listed as `<bot>-<node>`, display name `Name (node)`; chats run on the member through this gateway (`docs/FEDERATION.md` F5). Instructions, description, model and skills of such a bot answer 409 (change them on its machine); skills and toolsets list empty |

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
| Toolsets | `GET /api/tools/toolsets` | Partial | E2E, UI Tools page | Lists the bot's tool groups; toggling from Vory (`PUT /api/tools/toolsets/{name}`) is not implemented yet |

## Models

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| Model options | `GET /api/model/options?profile=` | Tested | E2E `restEndpointsAnswerJSON` | From Pi `ModelRuntime`; `authenticated` per provider |
| Session model switch | `config.set model "<m> --provider <p> --session"` | Tested | | Durable `configure({model})` |
| Reasoning effort | `config.set reasoning` | Tested | | Durable `thinkingLevel` |
| Fast mode | `config.set fast` | Gated | | Accepted and reported as unsupported |
| Default model of a bot | `PUT /api/profiles/{name}/model` | Partial | | Persists as a bot override; existing sessions keep their own model |

## Skills, config, status

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List skills | `GET /api/skills?profile=` | Tested | | `enabled` = active for that bot; per-bot skills are always listed, global ones when opted in |
| Toggle skill | `PUT /api/skills/toggle` | Tested | | Stored as a bot override |
| Slash command catalog | `commands.catalog` | Tested | E2E | Built-ins we really run + skills |
| Slash execution | `slash.exec`, `command.dispatch` | Partial | | `/compact`, `/usage`, `/status`; others return error 4018 |
| Config read | `GET /api/config`, `/api/config/schema` | Tested | E2E, UI Config page | Real settings only (approvals mode, default model, reasoning) |
| Config write | `PUT /api/config` | Deferred | | CLI / config file. Vory's Config page shows pickers; saving from it returns 404 for now |
| Env / keys | `GET /api/env` | Tested | E2E, UI Env page | Redacted; read-only |
| MCP servers | `/api/mcp/servers` | Deferred | | |
| Logs | `GET /api/logs` | Deferred | | |

## Scheduled tasks

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List jobs | `GET /api/cron/jobs` | Tested | | All bots by default, `?profile=` filters |
| One job / runs | `GET /api/cron/jobs/{id}`, `/runs` | Tested | | `/runs` returns `{runs:[{run_id,status,trigger,started_at,finished_at,summary,error}]}` |
| Edit | `PUT /api/cron/jobs/{id}` `{updates}` | Tested | | `{updates:{…}}`; unknown/read-only keys from Vory's raw editor are ignored; invalid schedule → 400 |
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
| Bot rooms (groups) | `groups.capabilities` | Gated | -32601 → Bot Mode hidden |
| Gateway voice (STT/TTS) | `/api/audio/*` | Gated | 404; Vory's on-device voice works |
| Files browser | `/api/files*` | Deferred | |
| Analytics | `/api/analytics/usage` | Deferred | |
| APNs push / Live Activity relay | `hermes-push` companion | Deferred | Pushover is our notification channel |
| Plugins hub, update, restart | `/api/dashboard/plugins/hub`, `/api/hermes/update*`, `/api/gateway/restart` | Deferred | systemd manages restarts |

## Cadu

Secondary target, not evaluated yet.
