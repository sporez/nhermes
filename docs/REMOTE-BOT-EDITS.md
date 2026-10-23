# Editing members' bots from any panel (plan)

Status: implemented.

## Goal

Any gateway's panel manages every bot in the network. The Bots screen keeps its local list and adds a
**Remote bots** section, one group per member, with the same editor local bots have: display name,
description, model and thinking, tool groups, approval mode, private, trusted, default, shared memory
spaces, instructions, skills, the system prompt view, create and remove. One panel is enough for all bot
management.

## Where we start

- The panel lists members' bots read-only from the roster (`remoteBots` in `/panel/api/state`,
  `src/panel/panel.ts`); every bot route refuses a remote bot with 409.
- All edits already go through the owning gateway's services: `Settings.editBot/addBot/removeBot`
  (`src/core/settings.ts`), `Skills.catalog/setEnabled`, `personaParts` for the prompt view, and
  `configView` (`src/admin.ts`) for the editor's data.
- Members already talk TLS-PSK keyed by the pair secret (`Members.call`) and reach only `/federation/*`. The owner-controlled precedent is
  `federation.acceptSecrets`: off until the owner turns it on in that machine's panel (Network).
- The roster only carries shareable bots (not private), with a short public view; it is the wrong channel
  for config.

## Decisions

1. **The owning gateway applies every edit.** A member never writes another machine's files. The panel
   on A calls `/panel/api/remote/<node>/…`; A forwards to B's `/federation/manage/…` with the pair
   secret; B runs the same `Settings`/`Skills` calls its own panel would.
2. **Opt-in per gateway, off by default**, like keys: "Let other machines edit this machine's bots" in
   each panel's Network screen (`federation.acceptBotEdits` in `settings`). A bot edit can make a bot
   trusted or change its instructions, so the owner turns it on knowingly. When off, the remote section
   shows that member's bots read-only with a note saying where to turn it on.
3. **All of the member's own bots are manageable when edits are allowed, private ones included.** A
   member that may flip `private` gains nothing by not seeing private bots, and the panel would otherwise
   lose a bot the moment it is made private. Peer entries (`peer:`) and B's own remote bots are not
   listed: only B's real local bots.
4. **The same fields the panel editor sends, nothing more.** `displayName`, `description`, `model`,
   `thinking`, `tools`, `skills`, `sharedMemory`, `recentChats`, `approvals`, `trusted`, `private`, `default`,
   `instructions`. Settings that point at the owning machine's files, hosts or credentials (`host`,
   `peer`, `workspace`, `soulFile`, `secrets`, `browser`, `desktop`) answer 400 from a member. Gateway
   settings (ground rules, defaults) stay on each machine's own panel; the prompt view is read-only for a
   remote bot.
5. **Choices come from the owner of the bot.** Model list, tool groups and skills are B's, fetched with
   the bot list, so the editor offers what B can actually run.
6. **Errors stay honest.** An offline member shows its bots from the roster as offline. A member's 401
   (it no longer accepts this machine) is passed on as 502 so the panel does not ask the user to sign in;
   only unreachable/401 answers mark the member unreachable (a 400/403/409 from B is an answer, not an
   outage).
7. **Logged on the owner.** Every member edit logs the bot, the fields and the member's name on B.

## Steps

- [x] Members: `acceptsBotEdits()` / `setAcceptsBotEdits()`; `call()` records `last_error` only for
  reachability failures.
- [x] Shared views (`src/panel/views.ts`): bot editor data (`configView` entries for local bots), the
  model list the panel offers, a bot's skills, a bot's prompt parts, used by both the panel and the
  federation routes.
- [x] Federation routes on the owning gateway (`src/federation/manage.ts`): `GET /federation/manage`,
  `POST /federation/manage/bots`, `PATCH|DELETE /federation/manage/bots/:name`,
  `GET /federation/manage/bots/:name/skills|prompt`, `PUT /federation/manage/bots/:name/skills/:skill`;
  403 unless allowed, field whitelist, local bots only.
- [x] Panel proxy routes `/panel/api/remote/:node/…` and the Network setting.
- [x] Panel UI: Remote bots section in the Bots screen (grouped by member, offline/not-allowed states),
  the editor, skills and prompt cards parameterised by where the bot lives, the Network toggle.
- [x] Tests: two in-process gateways; refused while off, list/edit/create/remove/skills/prompt while on,
  whitelist, private bots listed, remote bots and peers not editable, offline member, member errors do
  not mark it unreachable, panel 401 mapping.
- [x] Docs: `docs/FEDERATION.md` (follow-up done), `ARCHITECTURE.md`, `docs/STATUS.md`.

## The nHermes app

The app connects to one gateway. When the bot is a member's (`kind: "member"` in `bots.list`), that gateway
forwards the app's bot-settings operations (`docs/API.md`, "Bot settings") to the owning machine over the member
link, in `src/api/ops/bots.ts`:

- `bots.update`, `bots.delete`, `bots.setSkill` and `bots.settings` go to `/federation/manage/*` and need the
  "Let other machines edit this machine's bots" switch there. Only the fields in decision 4 are accepted;
  others answer 400. Changes are logged on the owning machine with the member's name.
- `bots.skills` and `bots.prompt` go to `/federation/read/bots/:name/*`. They need no switch for a shared bot
  (a private one is readable only when edits are allowed).
- `bots.rules` answers `not_available` for a member's bot: its "always allowed" rules are kept on its machine.
- The `mcp.*` operations with a member's `botId` follow the same split (`## MCP servers` below).

This replaced Vory's forwarding (`POST /federation/manage/vory/:bot`, `src/federation/vory.ts`), which is gone.

## MCP servers

The same switch lets other members' panels and the app (`mcp.create`, `mcp.update`, `mcp.delete`, `mcp.setForBot` with a member's `botId`) manage this machine's MCP servers (`/federation/manage/mcp/*`,
the MCP tab's "Other machines"; `docs/MCP.md`): list them with their state and tools, add, edit, turn on or
off, test, refresh and remove. The server's URL may be set from there; its headers name keys as
`{{secret:NAME}}`, and the key values are set on this machine (or copied with the Keys tab's "Send to", under
its own switch). A credential typed into a header is refused, and key values are never sent to a member.
Listing and reading a member's servers and testing one (`mcp.list`, `mcp.get`, `mcp.action` with `test`) go to
`/federation/read/mcp/*` and need no switch.

## Not in scope

- Remote memory and sessions in the panel (the Sessions screen already lists remote chats; memory stays
  per machine).
- Editing another machine's gateway settings.
