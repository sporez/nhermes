# Federation and control panel (plan)

Status: implemented (F1–F6); see Progress for what is still open.

Note (2026-10-23): the Hermes and Vory paths described in older sections (the `/api/profiles` list, the proxy
sessions in `src/federation/proxy.ts`, the member link in `link.ts`, `vory.ts`) were replaced by the client API
(`docs/CLIENT-API.md`, `docs/API.md`). Those sections keep their history; the bullets that say so describe how it
works now.

## Goal

Any number of machines run the same `nhermes serve` and form one network of equals. Adding a machine is
one command and a short code, with no tokens to create or copy by hand. Every member knows every other
member's bots: local bots can delegate to them, and the nHermes app, connected to any member, lists all of
them (`bots.list`) and chats with remote bots as if they were local. A bot can be kept private to its own
machine. A web control panel served by every gateway at `/panel` manages the network and the bots.

## Where we start

- Every gateway runs the same software; there is no "main" role. Today the gateway a client points at lists
  remote bots one by one as `peer: { url, tokenEnv, profile }` bot entries (`src/config.ts:44`,
  `deploy/config.example.yaml:46-49`). The link is one-way and the token is created and copied by hand.
- Delegation (`src/tools/delegate.ts`) reaches peer bots over the client API's socket, `/api/v1/ws`
  (`src/remote/peer.ts`, `docs/API.md`), idempotently and with approvals relayed to the root chat.
- Peers are not chat targets for the owner's app: `sessions.create` refuses `peer:` bots. (Written when the
  Hermes profile list was the client's view, which also never listed a gateway's own peers and so prevented
  transitive forwarding.)
- Bots come from `config.yaml`, read once at startup; edits from the panel and the app are written
  back to it at runtime (`src/core/settings.ts`); only skill toggles live in `app.sqlite`
  (`src/core/bots.ts`). The bot roster in each prompt is
  rebuilt every turn (`src/agent/extensions.ts:40-50`), so roster changes reach running conversations on
  their next turn.
- The CLI talks to the running gateway through `/admin/*` with the gateway token as `Authorization: Bearer`.
- `server.host` defaults to `127.0.0.1` in code (`src/config.ts:241`); the deployed config sets
  `0.0.0.0` (`deploy/config.example.yaml:3`).

## Decisions

1. **Members are equals.** No main gateway. Each member holds the full member list and connects directly
   to every other member; nothing is relayed through a third machine.
2. **Joining any member joins the whole network.** The member that accepts a join introduces the newcomer
   to everyone else over its existing authenticated links.
3. **Only the roster and reachability are shared.** Conversations, memory, skills, schedules, secrets
   and tool execution stay on the machine that owns the bot. No memory sync.
4. **Credentials are managed by the software.** Pairwise secrets are generated at join, stored in
   `app.sqlite` (`members` table), registered with the log scrubber, and included in backups only with
   `--secrets`. No `tokenEnv` for federation.
5. **Remote bots appear in the app's bot list through a live proxy**, not a turn-by-turn delegation mirror:
   streaming, tool calls, reasoning and approval cards behave as for a local bot.
6. **`private: true` keeps a bot on its own machine**: not in other bots' rosters, not a `delegate`
   target, not advertised to members.
7. **The control panel is a web page served by the gateway**, a client of the admin API, never an editor
   of files on its own. Settings changed in the panel are applied by the gateway and survive restarts.
   The CLI (`invite`, `join`, `members`, `reload`) covers headless use over SSH.
8. **Gateways listen on `0.0.0.0` by default**, so a headless machine is reachable by the app, members and
   the panel without editing the config. `server.host: 127.0.0.1` restricts it to the machine.
9. **The panel password is optional and off by default.** The owner's LAN is trusted (the owner and
   their household). The client API keeps requiring the gateway token.

## Phases

Each phase lands as tested commits and updates `docs/STATUS.md`, `docs/API.md` and
`ARCHITECTURE.md` where they change.

### F1. Private bots

- `private: true` on a bot in `config.yaml`; the panel flips it there.
- Excluded from the delegate roster prompt part (`src/app.ts:139-144`) and refused as a `delegate`
  target (`src/tools/delegate.ts:107-110`) with a "no bot named X" answer, so its existence is not
  revealed.
- Never advertised to members (F4).
- Still listed for the app on its own gateway.
- Tests: roster, delegate refusal, advertisement filter.

### F2. Runtime configuration

Prerequisite for the panel and for a roster that changes while the gateway runs.

- `Bots` reads a live config snapshot instead of the startup copy; `nhermes reload` and `SIGHUP` re-read
  `config.yaml` and validate it before swapping (a bad file keeps the running config and reports why).
- Admin endpoints to create, edit and remove local bots, and change gateway settings. Writes go to
  `config.yaml` through the `yaml` Document API so comments and ordering survive, then reload.
  The app's bot settings (`bots.update`) are written the same way; only skill toggles stay in `app.sqlite`.
- Removing a bot keeps its sessions, memory and workspace on disk; the panel says so.
- In-flight runs keep the agent config they started with; the next turn picks up changes. The
  scheduler re-reads jobs whose bot changed.
- Tests: reload with a valid and an invalid file, comment-preserving writes, create/edit/remove.

### F3. Membership: identity, invite, join, leave

- Each gateway has a `node` name (default: the host name) and a random node id, created at first start
  and kept in `app.sqlite`.
- `members` table: node id, name, URL, the pair's shared secret, joined/last-seen times, last error.
  `invites` keeps only a hash of each code's secret. Backups made without `--secrets` blank the pair
  secrets, so a restored machine joins again.
- `nhermes invite` on any member prints a join code (`nh1.…`): the member's URL plus a single-use secret,
  valid for 10 minutes. The URL is `node.url`, else the machine's LAN address (Tailscale's if it has no
  LAN address) and the listening port; `--url` overrides it.
- `nhermes join <code>` on the new machine first shows the inviting member's name, URL and member count
  and asks for confirmation (there are no keys to compare: the single-use code is the proof). Then it
  proves the code and receives the pair secret. The inviting member introduces the newcomer to every
  other member: it generates a secret for each new pair and delivers it to both ends, the old member over
  the link it already has (queued in `member_outbox` and retried when that member is offline).
- A gateway that is already in a network cannot join another one (networks are not merged); leave first.
- `nhermes members` lists members and their reachability. `nhermes members remove <name>` revokes the
  member everywhere (each member deletes its secret for it). `nhermes leave` does the same from the
  leaving side.
- Member-to-member calls go over TLS-PSK keyed by the pair secret (see "Encrypted links" below), so a
  member's credential never travels and cannot open the admin API. Members talk TLS-PSK only: the main
  port serves no `/federation/*` at all (404), and a member's WebSocket upgrade there is closed with 4401.
  A machine on a version without the encrypted port must be updated before it can join; a join code made
  by such a machine is refused before any request is sent.
- The app's API and the panel stay plain HTTP on the main port; put them behind a TLS proxy (Caddy) or Tailscale
  for encryption there.
- Migration: an existing `peer:` bot entry keeps working unchanged. Once its gateway joins, its bots
  also appear as discovered remote bots (F4); remove the old entry and its `tokenEnv` in the panel or
  config.yaml when convenient.
- Tests: two and three in-process gateways joining, introduction, removal, expired and reused codes,
  wrong secret.

### F4. Roster sync and delegation

- `GET /federation/roster` (member-authenticated) returns the member's non-private local bots: name,
  display name, description, model, reasoning level, and whether it is online.
- Each member polls every other member's roster at start and every few minutes, and immediately after a
  join or leave notice. Last-known rosters are kept in `app.sqlite`, so a down member's bots stay listed
  as unreachable rather than vanishing.
- Remote bots enter `Bots` as runtime entries named `<bot>-<node>` (for example `macbot-mac`), with a
  display name of `<Display> (<node>)`. Local names stay bare; a remote name that collides with a local
  one is skipped and reported in the panel. Why `-` (checked in Vory `d99369b`, `reference/vory/`):
  - Hermes profile names are `[a-z0-9][a-z0-9_-]{0,63}`, and Vory's transcript parsers assume that set
    (`Packages/VoryCore/Sources/VoryCore/Chat/TranscriptItem.swift:72,84,123`).
  - Vory's `@` highlighter reads letters, digits, `_`, `.` and `-` after the `@` and stops at a second
    `@` (`Vory/Chat/Mentions.swift`, `find`), so `@macbot@mac` would never be recognised as a mention.
  - Bot-room mentions match `@([A-Za-z0-9][A-Za-z0-9._:-]*)` (`Vory/Chat/GroupChat.swift:51`): no `@`
    or `/`.
  - `TranscriptItem.key` turns `scribe@laptop` and `peer/scribe` into `scribe`, which would merge a
    remote bot with a local one of the same name.
  - Bot first, so typing `@research` in the composer lists `research` and `research-mac` together (the
    picker matches name or display-name prefixes, `Vory/Chat/ComposerView.swift:62-65`).
- `delegate` reaches remote bots the way peer bots are reached today (`runOnPeer`), authenticated with
  the member secret. Delegating to an unreachable member fails with a clear "mac is offline" answer.
- Remote descriptions are text from another machine inserted into prompts: they are capped in length,
  stripped of control characters and rendered as quoted data in the roster section.
- Tests: roster merge, unreachable members, name collisions, private bots absent, description sanitising.

### F5. Remote bots in the app (first built for Vory)

The first two bullets keep the original Hermes/Vory design; the later ones say how it works now.

- `/api/profiles` and the WS profile list include remote bots, with the machine in the display name
  (`Nasbot (beta)`). `session.create` for a remote profile creates a local **proxy session**
  (`src/federation/proxy.ts`): the catalogue row is ours (title, preview, pins, archive), under the same
  id the conversation has on the owning member (`sessions.remote_node`; no Durable conversation here).
- One lasting member-authenticated WebSocket per member (`src/federation/link.ts`) carries the chat
  calls (`session.resume`, `prompt.submit`, steer, interrupt, title, usage, context, per-chat
  `config.set`, commands) and brings the member's events back, unchanged apart from the bot's name.
  Message history is read from the member. The member's approval requests are asked through this
  gateway's own approvals, so the client, push and the approval card work as for a local bot (today as `approval.requested` events, `docs/API.md`).
- After a dropped connection the link reconnects and resumes the chats being watched. While the member
  is offline, opening or starting a chat answers "<node> is offline" (decision: an error rather than a
  read-only view; the chat list still shows the last known titles).
- On the client API (`docs/API.md`), the same chats go through `src/federation/chats.ts` over the member's
  `/api/v1/ws`, and delegation, `peer:` agents and member bots' group chat turns use that API too
  (`src/remote/peer.ts`).
- Per-chat model and reasoning switches go to the member (`sessions.update`). Changing a member's bot
  (`bots.update`, `bots.setSkill`, `mcp.*` with that bot) goes to `/federation/manage/*` on the owning
  machine (`docs/REMOTE-BOT-EDITS.md`) and needs that machine's "Let other machines edit this machine's
  bots" switch. Reading a shared bot's skills and prompt (`bots.skills`, `bots.prompt`) and that machine's
  MCP servers (`mcp.list`, `mcp.get`, `mcp.action` with `test`) goes to `/federation/read/*` and needs no
  switch.
- Acceptance (first Vory's E2E suite and a Vory UI pass): now the client API's contract tests
  (`docs/API.md`) and a manual pass in the nHermes app for streaming, an approval card and a reconnect.

### F6. Web control panel (`/panel`)

Served by every gateway on its normal port (`http://<member>:<port>/panel`), so any member's panel
reaches the whole network. Plain HTML, CSS and a small amount of JavaScript in `src/panel/`, served as
static files: no framework, no build step, no new dependencies. Works on a phone or tablet screen.

Listening and access:

- `server.host` defaults to `0.0.0.0`, so a fresh headless install is reachable on the LAN; `nhermes
  init` writes it explicitly. `server.host: 127.0.0.1` keeps everything, panel included, on the machine.
  `GET /` redirects to `/panel/`.
- `panel.enabled` (default `true`) turns the panel off entirely.
- **No password by default.** `nhermes panel password` (or the Gateway screen) sets one; it is stored
  as a scrypt hash in `app.sqlite` (`settings`), not in config.yaml. With a password, a login sets an
  HttpOnly, SameSite=Strict cookie for 30 days, signed with a key in `app.sqlite`; changing the password
  signs every browser out. `nhermes panel password --clear` removes it.
- The page calls its own endpoints under `/panel/api/*` (`src/panel/panel.ts`), which call the gateway's
  services in-process. The panel never needs the gateway token; it is sent to the browser only when the
  owner asks for it (Gateway → Connect a client) or generates a new one (Keys).
- Even without a password, every change must come from the panel's own page: a custom
  `x-nhermes-panel` header (a cross-site page cannot send it without a CORS preflight, which is never
  granted), an `Origin` matching the gateway's host when present, a JSON body, and a `Host` that is an IP
  address, `localhost`, a single-label or `.local`/`.lan`/`.home.arpa`/`.internal`/`.ts.net` name, or
  `node.url`'s host (against DNS rebinding). The static files are served with a strict CSP.
- `/api/v1/*` (the app) and `/admin/*` (CLI) keep requiring the gateway token.

Screens:

- **Bots**: local bots (default, private, trusted badges) with an editor for display name, description,
  model and thinking, tool groups, approval mode, private, trusted, default, shared memory spaces and
  instructions; a Skills section with per-bot toggles and "Every global skill"; the bot's system prompt
  (ground rules editable there); create and remove bots; reload config.yaml. Members' bots are listed per machine
  under Remote bots with the same editor when that machine allows edits from other machines
  (`docs/REMOTE-BOT-EDITS.md`), otherwise view only, with an offline mark.
- **Network**: this machine and the members with reachability and last seen; invite (shows the code),
  join (preview, then confirm), remove, leave, refresh.
- **Sessions** (minimal): list by bot and archive state with title, last active and running state;
  rename, archive, stop a run, delete. Reading or continuing a chat stays in the nHermes app.
- **Memory** (minimal, local bots and shared spaces): search, view, add, edit, pin/unpin, delete,
  through the same store the `memory` tools and `nhermes memory` use.
- **Keys**: `secrets.env` write-only, optionally copied to members that accept keys
  (`docs/SECRETS-AND-REVIEW.md`).
- **Status**: running count, pending approvals (answerable from the panel), scheduled jobs with their
  schedule, options (same or fresh thread, result posted to chat, when it notifies) and last result,
  pause/resume and delete, the Jev review log.
- **Gateway**: node name and URL, defaults (model, thinking, approvals, approval timeout), time zone,
  listen address, Jev review settings, model lists (hidden providers), connect a client (addresses and
  the token on request), software updates; the panel password.

Not done in this phase (follow-ups): a "recent errors" view (the gateway keeps no log store) and a
browser smoke test of the page. Since done: per-bot skill toggles in the panel, and editing a member's
bots from another member's panel (`docs/REMOTE-BOT-EDITS.md`).

Tests: `test/panel/panel.test.ts` covers the panel API with and without a password (login, cookie,
logout, password change), refused writes (no header, foreign Origin, non-JSON, foreign Host), bots,
sessions, memory and approvals.

## Security notes

- A member can drive any non-private bot on every other member, subject to that bot's own approval
  mode; approvals for a delegated run are still asked in the chat that started it. Joining needs a
  single-use code made on a member and a confirmation on the joining machine for this reason, and
  `members remove` works from any member.
- Trust does not cross machines: a run started by a member is never treated as `trusted` on the owning
  gateway, whatever the caller's chain was.
- Configuration changes (`self_*`, `gateway_*`) are refused in work a member started, with one exception:
  the owner's own chat relayed from their client on a member (`sessions.create` with `relay: true`, which
  only this gateway's own chat link to the member sends, `src/federation/chats.ts`; source `member:<node>:owner`). There the `self_*` tools ask the owner as in a
  local chat when this machine has "Let other machines edit this machine's bots" on; `gateway_*` tools
  still need trust and stay refused. Delegated work (source `member:<node>`) is always refused. The mark
  is the member's word, the same trust the switch already gives it.
- Provider sign-ins on a member (`/federation/logins`, `src/federation/logins.ts`) are opt-in on the
  machine being signed in ("Let other machines sign this machine in to model providers", off by default,
  its own switch). Only the flow's device codes, links and prompts travel; the credential is saved by that
  machine's own store and never sent back. Calls are logged with the member's name and refused on a replaced
  key.
- Member secrets never reach prompts, logs or tool environments (the existing secret scrubbing and
  shell environment stripping apply).
- With no panel password, anyone on the LAN can change bots, invite machines and remove members. That is
  the owner's choice for a household LAN; set a panel password or `server.host: 127.0.0.1` on any
  machine reachable from a less trusted network.

## Encrypted links

Everything between two members (pair secrets, keys sent with "Send to…" or "Also set on", relayed chats,
delegated tasks, approvals, bot edits, sign-in codes and prompts) goes over TLS 1.2 with the pair secret as a pre-shared key
(`src/federation/psk.ts`, cipher `ECDHE-PSK-CHACHA20-POLY1305`). There are no certificates: both sides
prove they hold the secret in the handshake, the secret never travels, and ECDHE gives forward secrecy.

- **Port.** A second listener, the encrypted port, serves only `/federation/*` and the member WebSocket.
  It is `server.federationPort` when set (used as given; a clash stops the start), else the main port +
  1000, moving up to the next free port (10 tries). The port in use is advertised in `/federation/hello`,
  join codes, join answers, introductions and address announcements, and shown in the panel (Network).
- **Identity.** The handshake identity names the caller and which secret it uses (`m:<node id>:<key
  id>`); the server answers with that member's key or refuses the handshake. A joiner uses `i:<invite id>`
  with a key derived from the invite, so the join itself, and the pair secret it hands out, are
  encrypted with a key only the code's holder can make. Spent and expired codes fail in the handshake. The preview before joining reads `/federation/hello` the same way, so it also needs an open code.
- **Valid secrets only.** A pair secret is 32 or more base64url characters and a node id is letters,
  digits and hyphens (up to 64). The encrypted port refuses a row whose secret is blank or shorter (a
  backup made without `--secrets` blanks them, and the key for a blank secret is public); joins,
  introductions, join answers and key replacements with anything else are refused.
- **Replacing secrets.** The panel's "Regenerate key" replaces the secret of one pair over the encrypted
  link (`/federation/rotate`, which only the encrypted port serves). The old secret keeps opening the
  encrypted port for 10 minutes, for connections in flight, then nothing (the maintenance tick drops it). During that time it only keeps links alive: introductions, removals, address moves, key changes, shared keys, bot edits and provider sign-ins over it are refused (403, "this connection uses a replaced key; reconnect"). This protects against anyone who
  recorded traffic before; against someone actively intercepting at that moment with the old secret,
  remove the member and join it again.
- **Open links follow membership.** A member's WebSocket is checked once, at the upgrade, so it is also
  closed (4401) when that member is removed, leaves or is removed, and when its key was replaced and the
  grace has passed (the maintenance tick checks). Links this gateway opened to a removed member are
  closed too.
- **Only encrypted.** There is no plain HTTP path between members and no fallback to one; a fallback is
  what an attacker on the LAN would force. A member row without an encrypted port (left over from an
  older version) cannot be reached: calls say "<name> has no encrypted link; remove it and join it
  again", the panel shows the same, and startup logs a warning. Joins, introductions and join answers
  without an encrypted port are refused.
- **Address changes.** Every gateway remembers the address it last told the others (main URL and
  encrypted port). On every tick it compares, and when either changed it tells each member
  (`/federation/moved`, through the outbox, so an offline member gets it later). The moved gateway starts
  the call because it still knows where the others are; any one machine can move. A message can change a
  member's address and port but never remove the port.
- Hand-listed `peer:` gateways (token in config) are not members and are not covered.

## Notifications raised by a member

Notifications a member raises on its own (scheduled jobs, the `notify` tool, OpenChamber alerts) go to a
member that has a transport (Pushover, or Vory's push relay to devices Vory registered earlier) when the raising member has none. It posts them to
`POST /federation/notify`; the receiver delivers through its own transports only (never forwards again, so no
loops), answers 409 if it has none either, and the sender then tries the next member. The bot is mapped to the
name the receiver shows for it (`<bot>-<member>`); session ids are dropped. A gateway with its own transport
never forwards. Verified by `test/federation/notify.test.ts`.

## What `@` did in Vory (history)

Since replaced: the nHermes app lists bots with `bots.list` and runs group chats as `rooms.*`
(`docs/API.md`, "Group chats"), so none of the Bot Mode limits below apply to it. Checked in Vory `d99369b`. In an ordinary chat, `@` in the composer opens a picker over the gateway's
profiles (`/api/profiles`) and inserts `@name` as plain text (`Vory/Chat/ComposerView.swift:56-70`);
nothing is routed by the app. Replies that mention a known bot are drawn in that bot's colour as a link
to its card (`Vory/Chat/Mentions.swift`). Routing a message to the mentioned bots only happens in bot
rooms (Bot Mode), where the gateway resolves the handles; our gateway answers `groups.capabilities` with
-32601, so Bot Mode was hidden.

So F5 made remote bots appear in the picker and in mention links, and let the owner open a chat with
them. For `@macbot-mac do X` inside another bot's chat to reach that bot, the bot has to act on it: F4
adds a line to the roster prompt section saying that an `@name` addressed to another bot means
delegating the task to it. Bot rooms remain out of scope.

## Resolved

- Profile names for remote bots: `<bot>-<node>` (see F4).
- The panel manages sessions and memory minimally (see F6).
- Members talk TLS-PSK on their encrypted port (see "Encrypted links"); the app's API and the panel stay plain
  HTTP behind a TLS proxy or Tailscale.

## Progress

- [x] F1 private bots · `3d172d0`
- [x] F2 runtime configuration · `9c57770`
- [x] F3 membership · `c639105`
- [x] F4 roster sync and delegation · `678860c`
- [x] F5 remote bots in the app · `5041f9b` (built for Vory, whose E2E and UI pass never ran; since moved to the client API, see the note at the top; the pass in the nHermes app is still open)
- [x] F6 web control panel · `c4eade4`
