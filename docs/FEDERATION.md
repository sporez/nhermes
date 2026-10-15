# Federation and control panel (plan)

Status: implemented (F1–F6); see Progress for what is still open.

## Goal

Any number of machines run the same `nhermes serve` and form one network of equals. Adding a machine is
one command and a short code, with no tokens to create or copy by hand. Every member knows every other
member's bots: local bots can delegate to them, and Vory, connected to any member, lists all of them in
its `@` picker and chats with remote bots as if they were local. A bot can be kept private to its own
machine. A web control panel served by every gateway at `/panel` manages the network and the bots.

## Where we start

- Every gateway runs the same software; there is no "main" role. Today the gateway Vory points at lists
  remote bots one by one as `peer: { url, tokenEnv, profile }` bot entries (`src/config.ts:44`,
  `deploy/config.example.yaml:46-49`). The link is one-way and the token is created and copied by hand.
- Delegation (`src/tools/delegate.ts`) already reaches peer bots over the Hermes WebSocket
  (`src/remote/peer.ts`), idempotently and with approvals relayed to the root chat.
- Peers are hidden from Vory: `/api/profiles` and the WS profile list filter them out
  (`src/hermes/rest.ts:77`, `src/hermes/ws.ts:231`) and `sessions.create` refuses them
  (`src/core/sessions.ts:111`). `/api/profiles` never lists a gateway's own peers, which already prevents
  transitive forwarding.
- Bots come from `config.yaml`, read once at startup; runtime overrides (model, instructions,
  description, skill toggles) live in `app.sqlite` (`src/core/bots.ts`). The bot roster in each prompt is
  rebuilt every turn (`src/agent/extensions.ts:40-50`), so roster changes reach running conversations on
  their next turn.
- The CLI talks to the running gateway through `/admin/*` with the Vory session token (`src/cli.ts:95`).
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
5. **Remote bots appear as Vory profiles through a live proxy**, not a turn-by-turn delegation mirror:
   streaming, tool calls, reasoning and approval cards behave as for a local bot.
6. **`private: true` keeps a bot on its own machine**: not in other bots' rosters, not a `delegate`
   target, not advertised to members.
7. **The control panel is a web page served by the gateway**, a client of the admin API, never an editor
   of files on its own. Settings changed in the panel are applied by the gateway and survive restarts.
   The CLI (`invite`, `join`, `members`, `reload`) covers headless use over SSH.
8. **Gateways listen on `0.0.0.0` by default**, so a headless machine is reachable by Vory, members and
   the panel without editing the config. `server.host: 127.0.0.1` restricts it to the machine.
9. **The panel password is optional and off by default.** The owner's LAN is trusted (the owner and
   their household). Vory's API keeps requiring the gateway token as it does today.

## Phases

Each phase lands as tested commits and updates `docs/STATUS.md`, `docs/COMPATIBILITY.md` and
`ARCHITECTURE.md` where they change.

### F1. Private bots

- `private: true` on a bot in `config.yaml`, with an override in `app.sqlite` so the panel can flip it.
- Excluded from the delegate roster prompt part (`src/app.ts:139-144`) and refused as a `delegate`
  target (`src/tools/delegate.ts:107-110`) with a "no bot named X" answer, so its existence is not
  revealed.
- Never advertised to members (F4).
- Still listed for Vory on its own gateway.
- Tests: roster, delegate refusal, advertisement filter.

### F2. Runtime configuration

Prerequisite for the panel and for a roster that changes while the gateway runs.

- `Bots` reads a live config snapshot instead of the startup copy; `nhermes reload` and `SIGHUP` re-read
  `config.yaml` and validate it before swapping (a bad file keeps the running config and reports why).
- Admin endpoints to create, edit and remove local bots, and change gateway settings. Writes go to
  `config.yaml` through the `yaml` Document API so comments and ordering survive, then reload.
  Runtime-only fields stay in overrides.
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
- Member-to-member calls authenticate with the pairwise secret, in a header distinct from Vory's
  `X-Hermes-Session-Token`, so a member's credential cannot open the admin API.
- Transport: plain HTTP/WS. Members are on the owner's LAN, and away from home the owner reaches it over
  Tailscale (which encrypts). TLS is not built in and not planned.
- Migration: an existing `peer:` bot entry keeps working unchanged. Once its gateway joins, its bots
  also appear as discovered remote bots (F4); remove the old entry and its `tokenEnv` in the panel or
  config.yaml when convenient.
- Tests: two and three in-process gateways joining, introduction, removal, expired and reused codes,
  wrong secret.

### F4. Roster sync and delegation

- `GET /federation/roster` (member-authenticated) returns the member's non-private local bots: name,
  display name, description, model, and whether it is online.
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

### F5. Remote bots in Vory

- `/api/profiles` and the WS profile list include remote bots, with the machine in the display name
  (`Nasbot (beta)`). `session.create` for a remote profile creates a local **proxy session**
  (`src/federation/proxy.ts`): the catalogue row is ours (title, preview, pins, archive), under the same
  id the conversation has on the owning member (`sessions.remote_node`; no Durable conversation here).
- One lasting member-authenticated WebSocket per member (`src/federation/link.ts`) carries the chat
  calls (`session.resume`, `prompt.submit`, steer, interrupt, title, usage, context, per-chat
  `config.set`, commands) and brings the member's events back, unchanged apart from the bot's name.
  Message history is read from the member. The member's approval requests are asked through this
  gateway's own approvals, so Vory, push and the approval card work as for a local bot.
- After a dropped connection the link reconnects and resumes the chats being watched. While the member
  is offline, opening or starting a chat answers "<node> is offline" (decision: an error rather than a
  read-only view; the chat list still shows the last known titles).
- Per-chat model and reasoning switches go to the member. Vory's settings for a remote profile (Tools,
  Skills, Config, instructions, description, model, usage) were first refused with 409; they now go over
  the member link to the owning machine (`src/federation/vory.ts`, `docs/REMOTE-BOT-EDITS.md`), and
  changes need that machine's "Let other machines edit this machine's bots" switch.
- Acceptance: Vory's E2E suite run against a gateway with a remote profile selected; a manual pass in the
  Vory UI for streaming, an approval card and a reconnect.

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
- `/api/*` (Vory) and `/admin/*` (CLI) keep requiring the gateway token.

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
  rename, archive, stop a run, delete. Reading or continuing a chat stays in Vory.
- **Memory** (minimal, local bots and shared spaces): search, view, add, edit, pin/unpin, delete,
  through the same store the `memory` tools and `nhermes memory` use.
- **Keys**: `secrets.env` write-only, optionally copied to members that accept keys
  (`docs/SECRETS-AND-REVIEW.md`).
- **Status**: running count, pending approvals (answerable from the panel), scheduled jobs with their
  last result, pause/resume, the Jev review log.
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
- Member secrets never reach prompts, logs or tool environments (the existing secret scrubbing and
  shell environment stripping apply).
- With no panel password, anyone on the LAN can change bots, invite machines and remove members. That is
  the owner's choice for a household LAN; set a panel password or `server.host: 127.0.0.1` on any
  machine reachable from a less trusted network.

## What `@` does in Vory today

Checked in Vory `d99369b`. In an ordinary chat, `@` in the composer opens a picker over the gateway's
profiles (`/api/profiles`) and inserts `@name` as plain text (`Vory/Chat/ComposerView.swift:56-70`);
nothing is routed by the app. Replies that mention a known bot are drawn in that bot's colour as a link
to its card (`Vory/Chat/Mentions.swift`). Routing a message to the mentioned bots only happens in bot
rooms (Bot Mode), where the gateway resolves the handles; our gateway answers `groups.capabilities` with
-32601, so Bot Mode is hidden (`docs/COMPATIBILITY.md`).

So F5 makes remote bots appear in the picker and in mention links, and lets the owner open a chat with
them. For `@macbot-mac do X` inside another bot's chat to reach that bot, the bot has to act on it: F4
adds a line to the roster prompt section saying that an `@name` addressed to another bot means
delegating the task to it. Bot rooms remain out of scope.

## Resolved

- Profile names for remote bots: `<bot>-<node>` (see F4).
- The panel manages sessions and memory minimally (see F6).
- No built-in TLS; Tailscale covers access away from home.

## Progress

- [x] F1 private bots · `3d172d0`
- [x] F2 runtime configuration · `9c57770`
- [x] F3 membership · `c639105`
- [x] F4 roster sync and delegation · `678860c`
- [x] F5 remote bots in Vory · `5041f9b` (Vory E2E + UI pass not run yet)
- [x] F6 web control panel · `c4eade4`
