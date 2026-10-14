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

## Connection and auth

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| Liveness + auth shape | `GET /api/status` | Planned | | `auth_required: false`, `version`, `gateway_running`, `active_sessions` |
| Session-token auth | `X-Hermes-Session-Token`, `?token=` | Planned | | Wrong token: HTTP 401, WS close 4401 |
| Password / OAuth native sign-in | `/auth/native/*`, `/api/auth/*` | Gated | | `auth_providers: []`; Vory's session-token mode is used |
| Socket handshake | `/api/ws` → `gateway.ready` | Planned | | Payload `{skin:{}, change_events, heartbeat, replay_epoch}` |
| Heartbeat | `ping` | Planned | | `{pong: true}` |
| Server-request capability | `client.capabilities` | Planned | | Returns `["approval"]` only |
| Gateway capabilities | `gateway.capabilities` | Planned | | `per_session_exclusive_submit: true` |

## Bots (profiles)

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List bots | `GET /api/profiles`, `profiles.list` | Planned | | One profile per bot, `is_default` for the primary bot |
| Active bot | `GET /api/profiles/active` | Planned | | |
| Bot instructions | `GET/PUT /api/profiles/{name}/soul` | Planned | | SOUL = bot instructions |
| Bot description / model | `PUT /api/profiles/{name}/description`, `/model` | Planned | | |
| Profile home | `config.get {key:"profile"}` | Planned | | Bot workspace path |
| Create / delete / rename bots | `POST/DELETE/PATCH /api/profiles` | Deferred | | CLI manages bots |

## Sessions and chat

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List sessions | `GET /api/sessions?order=recent&limit=&profile=` | Planned | | Rows: `id,title,preview,source,model,started_at,last_active,message_count,is_active,archived,pinned,profile` |
| One session | `GET /api/sessions/{id}?profile=` | Planned | | 404 when another bot owns it |
| Messages page | `GET /api/sessions/{id}/messages` | Planned | | |
| Rename / pin / archive | `PATCH /api/sessions/{id}`, `session.title` | Planned | | |
| Delete | `DELETE /api/sessions/{id}`, `session.delete` | Planned | | Bot identity and memory untouched |
| Search | `GET /api/sessions/search?q=` | Planned | | Title/preview match |
| Create | `session.create` | Planned | | Runtime id == stored id |
| Resume snapshot | `session.resume` | Planned | | `messages`, `running`, `inflight`, `turn_started_at`, `open_requests`, `info` |
| Close | `session.close` | Planned | | Detaches the socket; the run continues |
| Send prompt | `prompt.submit` | Planned | | `status: streaming`; while busy: `queued` (Durable follow-up) |
| Steer | `session.steer` | Planned | | Durable `whenBusy: "steer"` |
| Stop | `session.interrupt` | Planned | | Durable `abort()` |
| Streaming | `message.start`, `message.delta`, `reasoning.delta`, `message.complete` | Planned | | `message.complete.text` is the whole run's text |
| Tool events | `tool.start`, `tool.complete` | Planned | | `tool_id` = Durable tool call id |
| Usage | `session.usage`, `session.usage` event | Planned | | From Durable `pi.usage` |
| Context breakdown | `session.context_breakdown` | Planned | | System / tools / conversation estimate |
| Title | `session.title` event | Planned | | First prompt, shortened |
| Multi-device fan-out | events to every attached socket | Planned | | |
| Reconnect during a run | `session.resume` mid-run | Planned | | Snapshot, then live events |
| Attachments | `image.attach_bytes`, `pdf.attach`, `file.attach` | Deferred | | |

## Tools and approvals

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| Approval request | server→client `approval` | Planned | | Enforced by a Durable `beforeTool` hook |
| Answer approval | response frame, `approval.respond` | Planned | | `once`, `session`, `always`, `deny` |
| Pending approvals | `approval.pending`, `approval.received` | Planned | | |
| Withdrawn request | `request.cancel` event | Planned | | On interrupt / timeout |
| Clarify / sudo / secret / vault prompts | server→client | Gated | | Not in `client.capabilities` result |
| Per-session YOLO | `config.set yolo` | Planned | | Allows everything except `deny` rules |
| Toolsets | `GET /api/tools/toolsets` | Planned | | Our tool groups per bot |

## Models

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| Model options | `GET /api/model/options?profile=` | Planned | | From Pi `ModelRuntime`; `authenticated` per provider |
| Session model switch | `config.set model "<m> --provider <p> --session"` | Planned | | Durable `configure({model})` |
| Reasoning effort | `config.set reasoning` | Planned | | Durable `thinkingLevel` |
| Fast mode | `config.set fast` | Gated | | Accepted and reported as unsupported |
| Default model of a bot | `PUT /api/profiles/{name}/model` | Planned | | |

## Skills, config, status

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List skills | `GET /api/skills?profile=` | Planned | | `enabled` = active for that bot |
| Toggle skill | `PUT /api/skills/toggle` | Planned | | Per bot |
| Slash command catalog | `commands.catalog` | Planned | | Built-ins we really run + skills |
| Slash execution | `slash.exec`, `command.dispatch` | Planned | | Small set: `/new`, `/compact`, `/usage`, `/skill <name>` |
| Config read | `GET /api/config`, `/api/config/schema` | Planned | | Real settings only (approvals mode, default model, reasoning) |
| Config write | `PUT /api/config` | Deferred | | CLI / config file |
| Env / keys | `GET /api/env` | Planned | | Redacted; read-only |
| MCP servers | `/api/mcp/servers` | Deferred | | |
| Logs | `GET /api/logs` | Deferred | | |

## Scheduled tasks

| Feature | Endpoint / method | Status | Verified with Vory | Notes |
|---|---|---|---|---|
| List jobs | `GET /api/cron/jobs` | Planned | | `job_id,name,schedule,prompt,deliver,enabled,state,next_run_at,last_run_at,last_status,profile` |
| One job / runs | `GET /api/cron/jobs/{id}`, `/runs` | Planned | | |
| Edit | `PUT /api/cron/jobs/{id}` `{updates}` | Planned | | |
| Pause / resume | `POST .../pause`, `.../resume` | Planned | | |
| Run now | `POST .../trigger` | Planned | | Held until the run ends, as Hermes does; 409 if running |
| Delete | `DELETE /api/cron/jobs/{id}` | Planned | | |
| Create | `POST /api/cron/jobs` | Planned | | Vory does not create jobs; the agent's `schedule_create` tool and the CLI do |
| Change notice | `cron.changed` event | Planned | | |

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
