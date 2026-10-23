# nHermes client API (v1)

The API the nHermes app (and any other client) uses to drive a gateway. It lives under `/api/v1` on the
gateway's main port: HTTP for every operation, and one WebSocket at `/api/v1/ws` for live events and, when
latency matters, the same operations. The implementation is `src/api/`; the plan that introduces it is
`docs/CLIENT-API.md`.

This page is the contract. A section marked *(planned)* describes what a later step of the plan adds.

## Conventions

- **JSON** with camelCase field names. Times are Unix milliseconds (`createdAt: 1761139200000`).
- **Ids** are opaque strings. Clients compare and store them, never parse them. A network member's bot has
  an id like `nasbot-beta`, but its machine comes from the bot's `node` field, not from the id.
- **Lists** answer `{items, nextCursor}`; pass `cursor` to get the next page. `nextCursor` is `null` on the
  last page.
- **Changes** use `PATCH` with only the fields that change and answer with the whole object.
- **Authentication:** `Authorization: Bearer <gateway token>` on every HTTP request and on the WebSocket
  upgrade. Nothing else is accepted (no token in the URL). A wrong or missing token gets HTTP 401, or the
  socket is closed with code 4401.
- **Network members** reach the API only over the WebSocket on the encrypted port, identified by their pair
  secret, and only the operations marked for members. They see only the chats they started and this
  machine's shareable bots.
- `GET /api/health` (no version, no token) answers `{ok: true}` for installers and service checks.

## Evolution

v1 only grows. Within v1:

- New operations, fields, event types, item types, content block types, error codes and enum values may be
  added at any time.
- A field is never removed, renamed or given a new meaning. A request never gains a required field; new
  request fields are optional and their default keeps the old behaviour.
- Clients **must** ignore fields they do not know, skip events, items and blocks of types they do not know,
  and decode every enum with a fallback for values they do not know.
- The gateway ignores request fields it does not know.
- A capability a client may lack is announced in `features` (see Hello); a client shows it only when its name
  is there.

A change that cannot follow these rules goes to `/api/v2`, served next to v1 until clients have moved.

## Errors

A failed call answers with an HTTP status and

```json
{"error": {"code": "session_not_found", "message": "No chat with id 20261022_101500_ab12cd.", "details": {}}}
```

Over the WebSocket the reply is `{"id": …, "error": {…}}` with the same object. `message` is plain words a
person can read; `details` is optional. Codes, with their HTTP status:

| Code | Status | Meaning |
|---|---|---|
| `invalid_params` | 400 | A parameter is missing or has the wrong type or value |
| `unauthorized` | 401 | No token, or the wrong one |
| `not_allowed` | 403 | The caller may not do this (for example a member switching approvals off) |
| `not_found` | 404 | Nothing at that path, or the thing named does not exist |
| `unknown_op` | 404 | No operation of that name (or none the caller may call) |
| `bot_not_found` | 404 | No bot with that id |
| `session_not_found` | 404 | No chat with that id |
| `approval_not_found` | 404 | No pending approval with that id |
| `method_not_allowed` | 405 | The path exists, the HTTP method does not |
| `conflict` | 409 | The current state does not allow it (a run already going, a disbanded group chat) |
| `too_large` | 413 | A body or upload over its limit |
| `unsupported_media` | 415 | An upload of a kind the gateway cannot use |
| `internal` | 500 | A bug; the gateway's log has the details |
| `member_offline` | 502 | The member machine that owns the bot or chat cannot be reached |
| `not_available` | 503 | Not possible on this gateway right now (a missing tool, nothing to restart it) |

## Hello

`GET /api/v1` (operation `gateway.hello`), and the first frame of every socket:

```json
{
  "api": 1,
  "gateway": {"id": "4f0c…", "name": "studio", "version": "0.1.0", "commit": "c67d427"},
  "bootId": "9b2e…",
  "features": ["events.replay"],
  "limits": {"toolResultChars": 65536, "imageBytes": 26214400, "fileBytes": 41943040},
  "caller": {"kind": "owner"}
}
```

- `bootId` changes when the gateway restarts; a client that sees a new one after reconnecting knows that
  anything it kept in memory about live state is stale.
- `caller` is `{"kind": "owner"}` or, for a network member, `{"kind": "member", "node": {"id", "name"}}`.
- `features` lists optional capabilities by name: `events.replay` (see Following a chat).

`GET /api/v1/ping` (operation `ping`) answers `{pong: true, at}`.

## WebSocket

`/api/v1/ws`. Each frame is one JSON object.

- **Call:** `{"id": 7, "op": "sessions.submit", "params": {…}}`. `id` is the client's (a number or string).
- **Reply:** `{"id": 7, "result": {…}}` or `{"id": 7, "error": {…}}`. A frame the gateway cannot read is
  answered with `{"id": null, "error": {"code": "invalid_params", …}}`.
- **Event:** `{"event": "turn.started", "sessionId": "…", "seq": 41, "at": 1761139200000, "data": {…}}`.
  `sessionId` and `seq` are present on a chat's events only.
- The gateway pings at the protocol level every 30 s and closes a socket that misses two. A client may also
  call `ping` to check the gateway from its side.
- There are no requests from the gateway to the client: everything the gateway needs answered (approvals)
  arrives as an event and is answered with an ordinary call, from any device.

## Operations

Every operation has a name and, unless it needs a socket, an HTTP route. Over HTTP, path parameters, query
parameters and a JSON body are merged into one parameter object; over the socket it is `params`.

| Operation | HTTP | Members | Notes |
|---|---|---|---|
| `gateway.hello` | `GET /` | yes | See Hello |
| `ping` | `GET /ping` | yes | |
| `bots.list` | `GET /bots` | yes | `{items: [Bot]}`. A member gets this machine's shareable bots |
| `bots.get` | `GET /bots/:id` | yes | `{bot}` |
| `sessions.list` | `GET /sessions` | | `botId?`, `archived?` (`exclude` default, `only`, `include`; `include` when `q` is given), `order?` (`recent` default: pinned first, then last active; `created`), `kinds?`, `q?` (title and preview), `limit?` (50, at most 200), `cursor?`. `{items: [Session], total, nextCursor}`. Without `kinds`, group-chat and delegated sessions are left out, except one with an approval waiting |
| `sessions.get` | `GET /sessions/:id` | yes | `{session}` |
| `sessions.create` | `POST /sessions` | yes | `botId?` (the default bot), `title?`, `source?`. `{session}`. A member may pass `kind: "room"` and `relay` |
| `sessions.update` | `PATCH /sessions/:id` | yes | Any of `title`, `pinned`, `archived`, `model` (`"provider/id"` or `{provider, id}`), `thinking`, `yolo`. `{session}`. A member may change only title, model and thinking |
| `sessions.delete` | `DELETE /sessions/:id` | yes | `{deleted: true}`. The bot, its memory and its jobs are untouched |
| `sessions.turns` | `GET /sessions/:id/turns` | yes | `limit?` (50, at most 500), `cursor?`. `{items: [Turn], nextCursor}`: the newest turns, oldest first; `nextCursor` names the page before |
| `sessions.subscribe` | socket only | yes | `id`, `limit?`, `afterSeq?`. See Following a chat |
| `sessions.unsubscribe` | socket only | yes | `id` |
| `sessions.submit` | `POST /sessions/:id/submit` | yes | `text`, or `content`: blocks `{type: "text", text}` and `{type: "attachment", id}`; `requestId?`. `{status: "started" \| "queued", submission}`. A chat that is answering queues the message. The same `requestId` is the same message, never sent twice; `submission` is `done` when a retry finds it already answered |
| `sessions.steer` | `POST /sessions/:id/steer` | yes | `text`. Placed after the current tool round. `{status: "steered" \| "started"}` |
| `sessions.interrupt` | `POST /sessions/:id/interrupt` | yes | Stops the run and withdraws its approvals. `{interrupted}` |
| `sessions.compact` | `POST /sessions/:id/compact` | yes | `instructions?`. `{started: true}` |
| `sessions.usage` | `GET /sessions/:id/usage` | yes | `{usage}` |
| `sessions.context` | `GET /sessions/:id/context` | yes | `{parts: [{id, label, tokens}], used, max, percent, estimated, model}` |
| `sessions.commands` | `GET /sessions/:id/commands` | yes | `{items: [{name, description, kind: "builtin" \| "skill", takesText, usage?, origin?}]}`. `new` is the client's own |
| `sessions.command` | `POST /sessions/:id/commands` | yes | `name`, `args?`. `{kind: "output", text}`, or `{kind: "prompt", text}` for a skill: send `text` as the next message |
| `sessions.toolResult` | `GET /sessions/:id/items/:itemId/result` | yes | A tool call's whole result: `{text, json?}` |
| `sessions.attach` | `POST /sessions/:id/attachments` | yes | The bytes as the body; `X-Filename` (URL-encoded) or `name`, and `kind?` (`image`, `pdf`, `file`; by default what the bytes are). Over the socket: `name`, `kind?`, `data` (base64). `{attachment}` |
| `sessions.detach` | `DELETE /sessions/:id/attachments/:attachmentId` | yes | Takes back an upload that has not gone with a message (its file is removed). `{withdrawn: true}`; `conflict` once sent |
| `attachments.content` | `GET /sessions/:id/attachments/:attachmentId/content` | yes | The file's bytes with its type. Over the socket: `{name, mime, data}` (base64) |
| `rooms.list` | `GET /rooms` | | `includeDisbanded?`, `limit?`, `cursor?`. `{items: [Room], nextCursor}`, most recently active first |
| `rooms.create` | `POST /rooms` | | `name`, `members: [{botId, handle?, displayName?, id?}]` (2-6 bots, this gateway's or members'), `id?` (the same id again is the same room). `{room}` |
| `rooms.get` | `GET /rooms/:id` | | `{room}` |
| `rooms.send` | `POST /rooms/:id/messages` | | `text`, `threadId?` (`main`), `eventId?` (the same id again is the same message). `{event}` |
| `rooms.events` | `GET /rooms/:id/events` | | `afterSeq?` (0), `limit?` (100, at most 500). `{items: [RoomEvent], latestSeq, hasMore}` |
| `rooms.disband` | `DELETE /rooms/:id` | | Stops the turn going and closes the room for good; its log and sessions stay. `{room}` |
| `bots.create` | `POST /bots` | | `name`, `cloneFrom?`, editor fields (see Bot settings). Clone copies settings and instructions, not name, default, display name, workspace, SOUL file or peer. `{bot}` |
| `bots.update` | `PATCH /bots/:id` | | Editor fields; `null` removes a setting. A member's bot takes only the fields its machine lets members change, and is changed there. `{bot}` |
| `bots.delete` | `DELETE /bots/:id` | | `{deleted: true}`; the default bot answers `conflict`. Its chats, memory and workspace stay |
| `bots.settings` | `GET /bots/:id/settings` | | What an editor needs: see Bot settings |
| `bots.skills` | `GET /bots/:id/skills` | | `{items: [{name, description, source, active, usage}], toolGroupOn, allGlobal}` |
| `bots.setSkill` | `PUT /bots/:id/skills/:name` | | `enabled`. `{skill}` |
| `bots.prompt` | `GET /bots/:id/prompt` | | The system prompt in parts: `{prompt: {instructions, identity, groundRules, generated, groundRulesCustom, builtInGroundRules, tools, full}}` |
| `bots.rules` | `GET /bots/:id/rules` | | The bot's "always allowed" approval rules: `{items: [{rule}]}`. A member's bot answers `not_available` (its rules are kept on its machine) |
| `bots.addRule` | `POST /bots/:id/rules` | | `rule`. `{rule: {rule}}` |
| `bots.removeRule` | `DELETE /bots/:id/rules` | | `rule`. `{deleted}` |
| `toolGroups.list` | `GET /tool-groups` | | `{items: [{name, label, description, tools}]}`. A bot's groups are its `toolGroups` (`bots.update`) |
| `mcp.list` | `GET /mcp/servers` | | `botId?`. `{items: [MCPServer]}`; with `botId` each has `enabledForBot`. A member's bot: that machine's servers |
| `mcp.get` | `GET /mcp/servers/:name` | | `botId?`. `{server}` with its tools (`toolList`), the server's instructions and recent changes |
| `mcp.create` | `POST /mcp/servers` | | `name`, settings, `botId?`. `{server}`. A credential header must be a `{{secret:NAME}}` reference |
| `mcp.update` | `PATCH /mcp/servers/:name` | | Settings (`null` removes one), `botId?`. `{server}` |
| `mcp.delete` | `DELETE /mcp/servers/:name` | | Removes it, and its tool group from every bot. `{deleted: true}` |
| `mcp.action` | `POST /mcp/servers/:name/:action` | | `test`: `{ok, error?, state, toolCount, tools}`; `reconnect`, `refresh`: `{ok: true, server}` |
| `mcp.setForBot` | `PUT /mcp/servers/:name/bots/:botId` | | `enabled`: gives the bot the server's tools or takes them away. `{server}` |
| `gateway.settings` | `GET /gateway/settings` | | See Gateway settings |
| `gateway.updateSettings` | `PATCH /gateway/settings` | | The same fields, all optional. `{settings, restartNeeded}` |
| `gateway.logs` | `GET /gateway/logs` | | `lines?` (200, at most 500). `{lines}`: what this process logged |
| `gateway.usage` | `GET /gateway/usage` | | `days?` (30, at most 366), `botId?`. See Usage analytics |
| `keys.list` | `GET /keys` | | `{items: [{name, set, description, usedBy, hint}]}`. Never a value |
| `keys.set` | `PUT /keys/:name` | | `value`. `{key, restartNeeded}`. The gateway's own token answers `not_allowed` |
| `keys.delete` | `DELETE /keys/:name` | | `{key, restartNeeded}` |
| `jobs.list` | `GET /jobs` | | `botId?`. `{items: [Job]}` |
| `jobs.get` | `GET /jobs/:id` | | `{job}` |
| `jobs.create` | `POST /jobs` | | `name`, `prompt`, `schedule` (`every 1h`, cron, `at …`), `botId?`, `timezone?`, `notify?`, `deliver?`, `context?`, `approvals?`, `model?`, `skills?`, `enabled?`. `{job}` |
| `jobs.update` | `PATCH /jobs/:id` | | The same fields. `{job}` |
| `jobs.delete` | `DELETE /jobs/:id` | | `{deleted: true, id}` |
| `jobs.runs` | `GET /jobs/:id/runs` | | `limit?` (20, at most 200). `{items: [Run]}`, newest first |
| `jobs.run` | `POST /jobs/:id/run` | | Starts a run now. `{run}` at once; `jobs.changed` follows. `conflict` while one is going |
| `jobs.pause`, `jobs.resume` | `POST /jobs/:id/pause`, `/resume` | | `{job}`. Resuming computes the next run from now |
| `files.list` | `GET /files` | | `path?` (absolute; none: one entry per bot's workspace). `{path, parent, items: [{name, path, isDirectory, size, modifiedAt, mime, botId?}]}`. Read-only, inside the workspaces only |
| `files.content` | `GET /files/content` | | `path`. The bytes (base64 `{name, mime, data}` over the socket); at most 50 MB |
| `sessions.file` | `GET /sessions/:id/files/content` | yes | `path`, relative to the chat's bot's workspace or absolute inside it: a picture a reply names, also for a chat with a member's bot |
| `software.status` | `GET /software` | | `{version, commit, branch, behind, commits, lastCheck, canUpdate, canRestart, reason, running}` |
| `actions.start` | `POST /actions` | | `kind`: `check`, `update`, `restart`, `doctor`. `{action}` |
| `actions.get` | `GET /actions/:id` | | `{action}`: `{id, kind, status: "running" \| "done" \| "failed", startedAt, finishedAt, exitCode, lines}`. An update or restart stays `running` until the restarted gateway answers |
| `approvals.list` | `GET /approvals` | yes | `sessionId?`. `{items: [Approval]}`, oldest first |
| `approvals.answer` | `POST /approvals/:id` | yes | `choice`: one of the request's `choices`. `{answered: true}`; `approval_not_found` when it is no longer waiting |
| `models.list` | `GET /models` | yes | `botId?`. `{providers: [{id, name, models: [{id, name, reasoning, thinkingLevels, input, contextWindow}]}], current: {provider, id}}` |

## Chats with a member's bot

A network member's bot (`kind: "member"`) chats like a local one: create the chat with its `botId`, and use
the same operations. This gateway keeps the chat in its own list (title, pins, archive) and passes
everything else on to the member's machine, which runs it; ids in what comes back are this gateway's. The
member's approval requests are asked here, as `approval.requested` events like any other, with a
description that starts with `from <machine>:`. Uploads into such a chat are kept on the member.

- `yolo` cannot be switched on for such a chat (`not_allowed`): its approvals are the member's.
- When the link to the member drops, a followed chat gets `session.stale`: subscribe again.
- While the member is offline, calls about its chats answer `member_offline`; the chat list still shows
  them.

## Bots

```json
{
  "id": "nasbot-beta", "name": "nasbot", "displayName": "NAS bot", "description": "…",
  "isDefault": false, "kind": "member", "node": {"id": "…", "name": "beta", "online": true},
  "model": {"provider": "openai", "id": "gpt-5.5"}, "thinking": "medium", "approvals": {"mode": "smart"},
  "toolGroups": [], "skillCount": 0, "private": false, "trusted": false, "avatar": null
}
```

`kind` is `local` (this gateway's), `member` (a network member's, `node` set) or `peer` (a configured
`peer:` agent; not listed today). `toolGroups` and `skillCount` are a local bot's. `thinking` is one of
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`. `avatar` is reserved.

## Sessions

```json
{
  "id": "20261022_101500_ab12cd", "botId": "main", "kind": "chat", "title": "Plans", "preview": "…",
  "source": "app", "createdAt": 1761139200000, "lastActiveAt": 1761139260000, "messageCount": 4,
  "running": false, "archived": false, "pinned": true, "model": {"provider": "faux", "id": "faux-2"},
  "thinking": "low", "yolo": false, "approvalMode": "smart", "approvalsWaiting": 0,
  "parentId": null, "jobId": null
}
```

`kind`: `chat`, `job` (a scheduled task's runs), `delegate` (work another bot asked for), `room` (a bot's
session for a group chat). `model` and `thinking` are the chat's: its own when it chose them, else its
bot's. `yolo` is the chat's Bypass switch: approvals are skipped (deny rules and changes to the gateway's
configuration still apply); it resets when the gateway restarts.

## Turns

A chat is a list of turns. A turn opens with each of the owner's messages and holds what the bot did in
answer, in order.

```json
{
  "id": "t42", "status": "complete", "startedAt": 1761139200000, "endedAt": 1761139211000,
  "user": {"content": [{"type": "text", "text": "How many?"}], "at": 1761139200000},
  "items": [
    {"type": "reasoning", "id": "t42.1r", "text": "…", "at": 1761139200100},
    {"type": "text", "id": "t42.1t", "text": "Checking.", "at": 1761139200100},
    {"type": "tool", "id": "call_7", "name": "mcp__cal__list_events", "args": {"day": "today"}, "preview": "today",
     "status": "done", "isError": false, "startedAt": 1761139201000, "durationMs": 420,
     "result": {"text": "2 events", "truncated": false, "length": 8, "json": {"events": []}}},
    {"type": "text", "id": "t42.2t", "text": "There are two.", "at": 1761139202000}
  ],
  "usage": {"input": 1200, "output": 80, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0.0012, "calls": 2}
}
```

- `status`: `running`, `complete`, `error` (with `error`), `interrupted`. `endedAt` is `null` while running,
  and for turns from before the gateway recorded run ends.
- `user` is `null` for a turn that only carries a notice (a scheduled task's result posted into the chat,
  a compaction marker).
- Content blocks: `{type: "text", text}`, `{type: "attachment", attachment: {id, kind, name, pages?}}`
  (`kind`: `image`, `pdf`, `file`; `id` is `null` only when an old upload's file is gone).
- Items: `reasoning`, `text` (one reply part; a run with tool calls has several), `tool`, `notice`
  (`{kind, text, at}`), `error` (`{message, at}`).
- A tool item's `status`: `running`, `done`, `failed`, `blocked` (refused: the owner denied it or a rule
  did; it never ran), `unknown` (the run ended before it reported). `durationMs` is `null` when it never
  ran. `result.text` is cut at the hello's `toolResultChars` (`truncated`, `length` say so;
  `sessions.toolResult` returns it all). `result.json` is structured data the tool returned beside its
  text, such as an MCP server's `structuredContent`; absent when there is none or it is over 256 KB.
- Ids: a turn's id stays the same live and in history, and so do its items' ids.

## Following a chat

Over the socket, `sessions.subscribe {id}` answers with the chat's state and starts its live events:

```json
{"session": {…}, "seq": 41, "turns": {"items": [Turn], "nextCursor": null}, "approvals": [Approval]}
```

The running turn (if any) is in `turns` with what has streamed so far. Events of this chat carry `seq`; an
event with a `seq` at or below the snapshot's is already in it and must be skipped (one can arrive just
before the reply). `seq` only grows, with gaps. `sessions.submit` over a socket also subscribes it.

After a reconnect, subscribe again. With feature `events.replay`, pass the last `seq` the client applied as
`afterSeq`: when the gateway still has every event after it, the answer is
`{session, seq, replay: [events], approvals}`, the missed events in order, and live events continue after
them. Otherwise (too long away, or the hello's `bootId` changed: then do not pass `afterSeq` at all) the
answer is the snapshot above, which replaces what the client holds. A gateway keeps a chat's latest 2,000
events for 5 minutes after its last follower leaves.

## Events

A followed chat's events (with `sessionId` and `seq`):

| Event | Data |
|---|---|
| `turn.started` | `{turn}`, its `items` empty |
| `item.started` | `{turnId, item}`: a reply part, reasoning or tool call begins (a tool call when the model asks for it) |
| `item.delta` | `{turnId, itemId, field, text}`: append `text` to the item's `field` (`text` for replies and reasoning, `output` for a running tool's output) |
| `item.updated` | `{turnId, item}`: the whole item, replacing it (a tool call starting to run) |
| `item.finished` | `{turnId, item}`: the whole finished item |
| `turn.finished` | `{turnId, status, endedAt, error?, usage?}` |
| `usage.updated` | `{usage}` |
| `session.notice` | `{kind: "compacting" \| "notice", text}` |
| `session.stale` | `{}`: events of this chat may have been missed (a member's link dropped); subscribe again |

Every owner socket also gets, without subscribing:

| Event | Data |
|---|---|
| `session.updated` | `{session}`: a chat's row changed (title, a run starting or ending, pins, settings) |
| `session.deleted` | `{id, botId}` |
| `sessions.changed` | `{botId}`: several of a bot's chats may have changed; list them again |
| `approval.requested` | `{approval}` |
| `approval.resolved` | `{id, sessionId, choice, reason}`: `reason` is `answered` (on any device), `timeout` or `cancelled` (interrupt) |
| `jobs.changed` | `{}` |
| `bots.changed` | `{}`: bots' settings changed, or a member machine's list of bots did; list them again |
| `room.updated` | `{room}`: a group chat was created or disbanded |
| `room.event` | `{roomId, event}`: a group chat filed an event in its log |

A member's socket gets the approval events of the chats it started, and their `session.updated`.

## Attachments

Upload first, then name the uploads in the message:

```
POST /api/v1/sessions/<id>/attachments      (body: the bytes; X-Filename: IMG_0042.jpg)
→ {"attachment": {"id": "a3f9…", "kind": "image", "name": "IMG_0042.jpg", "mime": "image/jpeg", "size": 81234, "sent": false}}

POST /api/v1/sessions/<id>/submit
{"content": [{"type": "text", "text": "What is this?"}, {"type": "attachment", "id": "a3f9…"}], "requestId": "…"}
```

- Pictures: PNG, JPEG, GIF, WebP or BMP, up to the hello's `imageBytes`. The name's extension follows what
  the bytes are. A picture of another kind (HEIC, TIFF) is kept as a file unless `kind: "image"` is asked
  for, which answers `unsupported_media`; convert it first to let the model see it.
- PDFs: up to `fileBytes`; the first 25 pages are shown to the model as pictures when the gateway can render
  them (`pages` says how many).
- Other files: up to `fileBytes`; a text file's contents go to the model with the message, any other file
  as a note saying where it is.
- An upload belongs to its chat. It can go with more than one message; until it has gone with one,
  `sessions.detach` takes it back. Uploads are kept in the bot's workspace `uploads/` folder.
- In a turn, `user.content` names each attachment by id; `attachments.content` (with the chat's id) opens
  it. Chats from before
  uploads had ids get one when their history is read, if the file is still there.

## Group chats

A room is 2-6 bots and one ordered log. The owner's message is answered by the bots it @mentions (all of
them when it mentions none, `@all`, `@everyone`), one at a time, then up to two more rounds for bots another
bot @mentioned; a bot may pass. At most 3 rounds and 10 bot messages answer one message. A member machine's
bot answers on its own machine.

```json
{"id": "room-abc123", "name": "Main, Ops", "members": [{"id": "main", "botId": "main", "handle": "main", "displayName": "Main"}],
 "createdAt": 1761139200000, "updatedAt": 1761139260000, "disbandedAt": null, "latestSeq": 8}
```

A log event: `{roomId, seq, id, kind, actor: {kind, id}, data, at}`. Kinds: `message.user` (`{text,
threadId}`), `turn.started` (`{memberId, turnId, threadId, discussionEventId, roundIndex, …}`),
`message.member` (`{text, memberId, turnId, threadId, discussionEventId}`), `turn.settled` (`{turnId,
messageEventId, passed}`), `turn.failed` (`{turnId, error}`), `room.activity` (`{status: "settled" |
"bounded" | …, threadId, discussionEventId, memberId?}`, for example a bot waiting for an approval in its own
room session), `room.disbanded`. Each new event is pushed to owner sockets as `room.event`; `rooms.events`
reads the log from any `seq`.

## Bot settings

`bots.settings` answers `{botId, config, effective, editableKeys, choices}`: `config` is the bot's entry as the
gateway keeps it, `effective` what is in force (`displayName`, `description`, `model` as `provider/id`,
`thinking`, `tools`, `approvals`, `recentChats`, `trusted`, `private`, `default`, `instructions`,
`instructionsFrom`), `editableKeys` what may be changed from here, and `choices` the models, tool groups and
shared memory spaces to pick from. For a member's bot it comes from that machine, which shows only what members
may change (never its host, workspace or keys), and changes need its "Let other machines edit this machine's
bots" switch (`not_allowed` until it is on). Without the switch a client can still read a shared bot's skills
(`bots.skills`) and prompt (`bots.prompt`), list that machine's MCP servers and test one.

An MCP server: `{name, group, url, description, enabled, exposure, timeoutS, maxTimeoutS, healthCheckS, tools:
{include, exclude, readOnly}, trustReadOnlyHint, headers: [{name, value}], secrets: [{name, set}], botIds,
warnings, status: {state, since, lastError, lastConnectedAt, offlineSince, nextAttemptAt, …}, toolCount,
exposedCount, readOnlyCount, enabledForBot?}`. A header value is a `{{secret:NAME}}` reference, a harmless
literal, or `null` when its name looks like a credential; no key is ever returned.

## Gateway settings

`{timeZone, defaults: {model, thinking, approvals, approvalTimeoutS}, hiddenModelProviders, groundRules,
review: {enabled, allowThreshold, timeoutMs, keyEnv}}`. `groundRules` is `null` for the built-in rules (send
`null` to go back to them). `restartNeeded` names the settings that take effect only after a restart (time
zone, approval timeout); until then the answer shows the values in force.

## Scheduled tasks

A job: `{id, name, botId, prompt, schedule, scheduleDetail: {kind, timezone}, timezone, deliver, notify,
context, approvals, model, skills, enabled, state: "active" | "running" | "paused" | "completed", nextRunAt,
lastRunAt, lastStatus, lastError, sessionId, createdAt, updatedAt}`. A run: `{id, jobId, trigger, status,
startedAt, finishedAt, summary, error, notified, sessionId}`. `sessionId` is the job's chat, where its runs are.

## Usage analytics

`{days, daily: [{day, input, output, cacheRead, reasoning, cost, calls, sessions}], byModel: [{model, …}],
totals: {…}}`: every model call in the bots' chats over the last `days` (in the gateway's time zone), cost in
USD. A member's bot's chats are on its own machine and count there.

## Approvals

```json
{
  "id": "a1b2c3d4e5f6", "sessionId": "…", "botId": "main", "toolName": "bash",
  "command": "rm -rf ./tmpdir; echo cleaned", "description": "recursive forced delete",
  "choices": ["once", "session", "always", "deny"], "patternKey": "rm -rf", "createdAt": 1761139200000,
  "toolCallId": "call_7", "callSessionId": "…"
}
```

`sessionId` is where the owner answers: the chat the work started in. `callSessionId` is the session the
call runs in (a delegated task's own session) and `toolCallId` the tool item it holds. `once` lets this call
run, `session` allows the pattern for the rest of the chat, `always` for the bot, `deny` refuses it. A
request no one answers is denied when the gateway's approval timeout passes.

## Usage

`{model, input, output, reasoning, cacheRead, cacheWrite, total, calls, contextUsed, contextMax,
contextPercent, costUsd}`: the chat's totals to date; `contextUsed` is the last model call's.
