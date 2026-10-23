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
  "features": [],
  "limits": {"toolResultChars": 65536, "imageBytes": 26214400, "fileBytes": 41943040},
  "caller": {"kind": "owner"}
}
```

- `bootId` changes when the gateway restarts; a client that sees a new one after reconnecting knows that
  anything it kept in memory about live state is stale.
- `caller` is `{"kind": "owner"}` or, for a network member, `{"kind": "member", "node": {"id", "name"}}`.
- `features` lists optional capabilities by name.

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
