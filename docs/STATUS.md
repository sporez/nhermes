# Status (2026-10-16)

"Automated" = our suite (`npm test`, 90 tests, faux model, no network). "Live" = exercised against a real
model (now `neuralwatt/deepseek-v4.1-flash`; earlier runs used `cerebras/gpt-oss-120b`, both via Pi's provider layer) and/or the stock Vory client.

Deployment under test: three gateways in one network, all on port 9119 with the encrypted member port
10119: the **hermes VM** and **media VM** (Debian 13, systemd user services) and the **Mac** (launchd).
The original Hermes was removed from the hermes VM and the Mac on 2026-10-16. On the hermes VM: Bots: `main`, `ops` (trusted, SSH host),
`desktop` (XFCE on `:0`), `mac` (peer agent on Neil's Mac; since replaced by the network of gateways, `docs/FEDERATION.md`).

| # | Definition of done | Automated | Live | Notes |
|---|---|---|---|---|
| 1 | Gateway on Debian | – | ✅ systemd user service on the hermes VM | `docs/OPERATIONS.md` |
| 2 | Stock Vory connects | protocol tests | ✅ Vory `GatewayIntegrationTests` pass against the Mac and the VM gateway; Vory UI E2E (onboarding → chat → settings) passes | 2 Vory tests are mock-only (see COMPATIBILITY) |
| 3 | Chat with a named agent on a configured model | ✅ | ✅ | |
| 4 | Tool activity + genuine approvals | ✅ | ✅ real model asked to install a package: approval request over Hermes protocol; deny blocked it, once ran it | Approval card in the Vory UI itself not yet driven live |
| 5 | Disconnect, restart, recover | ✅ mid-answer, pending approval, job mid-run | ✅ sessions survive service restarts | |
| 6 | Second agent, own identity/model/skills/memory | ✅ | ✅ `ops`, `desktop` | |
| 7 | Remote VM administration | ✅ (pi-env daemon) | ✅ `ops` runs on the hermes VM itself (no `host:`) and reaches `pm` and `proxy` with its own SSH key, following the `homelab-vms` skill | Bot `host.ssh` stays available for a bot that should live on another machine |
| 8 | Delegation and result | ✅ foreground, background, approvals routed to root chat, no privilege escalation | ✅ main → ops, main → mac (peer) | |
| 9 | SKILL.md skill | ✅ | ✅ `disk-report` loaded and followed | |
| 10 | Memory across sessions, search, sharing | ✅ incl. boundaries | ✅ remember in one chat, recall in another | |
| 11 | Recurring task from agent/Vory, unattended, history | ✅ | ✅ created from chat, Run now from the cron API, history | |
| 12 | Notifications | ✅ Pushover (recording transport); Vory push relay incl. member bots (`test/hermes/vory-push.test.ts`, `test/federation/vory-push.test.ts`); a member with no transport forwards its own notifications to one that has it (`test/federation/notify.test.ts`) | Pushover ❌ skipped by owner (no keys) | `PushoverNotifier` untested against the real API; Vory push (`src/notify/vory.ts`) is the main channel |
| 13 | Browser workflow | ✅ local site, multi-tab, refs, persistence | ✅ Wikipedia search → article → infobox → screenshot | |
| 14 | Remote desktop interaction | – | ✅ hermes VM XFCE: open Mousepad, type, verify via AT-SPI | The editor restored an unsaved draft from an earlier run, so the document was not empty |
| 15 | Independent VM-resident agent | ✅ two gateways, relayed approval, dropped connection | ✅ peer on the Mac, registered with the VM gateway, answered a delegated task | The peer runs on a Mac, not a VM |
| 16 | Backup and restore | ✅ | ✅ on the VM: backup while running, restore refused while running, restore + restart | |
| 17 | OpenChamber threads (`openchamber` tool group, `openchamber_alerts` event watcher) | ✅ fake server: read and control tools, policy, event watcher (permission, form, failure, finish stays quiet, child skip, debounce, reconnect) | Live, 2026-10-18, tools run locally against OpenChamber 2.4.0 / OpenCode 2.0.32: oc_sessions, oc_read, oc_waiting, oc_diff (whole thread and last turn) ✅; oc_start with OpenChamber's default model and variant ✅, the thread shows in OpenChamber ✅; oc_answer on a real question ✅; oc_prompt ✅; oc_stop interrupts a running tool ✅; the watcher reported the question and the finished thread from the live stream ✅; a permission card escalated past the Jev reviewer showed in oc_waiting with the reviewer's recommendation, and oc_approve rejected it, the thread saw the rejection ✅ | The watcher's permission notice is tested on the fake server only. Not yet run through a deployed gateway and Vory |

## Client API (`/api/v1`, `docs/API.md`)

Automated (`test/api/`): Bearer auth on HTTP and the socket, hello, errors, one operation over both
transports, member-only operations; chats live and in history with the same turn and item ids, tool
items with arguments, result, structured result (MCP `structuredContent`), duration and status (blocked
when refused), following a chat mid-answer, approvals announced and answered on any device, interrupt,
chat settings, commands, redaction of every new field; uploads by id (pictures, PDFs, files, as bytes or
base64), taken back before sending, opened from history, old chats' uploads given ids; chats with a
member's bot through this gateway (calls, events, approvals asked here, uploads kept there, a dropped link,
an offline member), a member on the encrypted port limited to its own chats and shareable bots.
Delegation, `peer:` agents and member bots' group chat turns run over the client API
(`test/remote/peer.test.ts`, `test/core/delegate.test.ts`, `test/federation/rooms.test.ts`,
`test/federation/network.test.ts`). Not yet used by a client.

## Security findings fixed during live testing

- A denied package install was retried by delegating to the trusted `ops` bot → delegation now never
  raises privileges (`test/core/delegate.test.ts`).
- Untrusted bots could `sudo apt-get install` without asking → installs and `sudo` now ask.
- A remembered "always" answer for one pattern could cover another pattern in the same command → every
  matching pattern must be allowed on its own (`test/core/policy.test.ts`).

- Bots' shells inherited the gateway's environment, including provider keys and the gateway token →
  shells now get a scrubbed environment and known secret values are redacted from tool output, transcript
  rows and events (`test/core/web.test.ts`). Redaction of streamed text works per delta, so a secret split
  across two deltas would not be caught there (the stored transcript row is still redacted).

Found in a security audit (2026-10-20), fixed with regression tests:

- A bot's `http_request`, `web_fetch` and browser tools could use the gateway's own passwordless panel
  from the machine itself (read the token, answer their own approvals) → the gateway's `/panel` is
  refused to them, also after a redirect (`test/core/web.test.ts`, `test/computer/browser.test.ts`).
  The browser tools also refuse `file://` URLs inside the gateway's own folders.
- `http_request` carried a key in a custom header across a redirect to another host → secret headers are
  dropped on a cross-origin hop, and a 307/308 with a key in its body or URL is not followed
  (`test/core/web.test.ts`).
- A backup without `--secrets` blanked pair secrets to `''`, and the encrypted port accepted the key of an
  empty secret, which anyone can compute → blank and short secrets never open the encrypted port
  (`test/federation/psk.test.ts`). Such backups also leave out previous secrets, queued introductions and the
  panel cookie key. Every backup is written owner-only (`test/core/backup.test.ts`).
- Members talk only over TLS-PSK. The member-secret header login and `/federation/*` on the main port are
  gone, so no pair secret or key travels in clear and the upgrade probe can no longer be blocked. Done after
  checking that every live pair was encrypted and rotated (`test/federation/network.test.ts`,
  `psk.test.ts`).
- A connection made with the replaced pair key during its grace period could rotate the pair to a key of
  its choosing → that key keeps links alive but cannot change the pair, and it is cleared after the grace
  (`test/federation/psk.test.ts`).
- A removed member's open WebSocket kept working → member sockets close when the member is forgotten or
  their key stops being accepted (`test/federation/network.test.ts`).
- Chat titles and previews made from a prompt that held a key were listed unredacted → redacted in the
  chat lists of both APIs (`test/api/chat.test.ts`).
- Live events (reasoning, errors, tool results, approval cards, resume snapshots), approval audit rows and
  forwarded notifications were not redacted. JSON-escaped forms of a key were missed, and keys from the
  service environment were never registered → all are redacted now (`test/hermes/protocol.test.ts`,
  `test/core/secrets.test.ts`, `test/federation/notify.test.ts`).
- Smaller hardening:
  - A `peer:` token travels in a header, not the URL.
  - The TLS-PSK handshake has a 10 s timeout.
  - Repeated wrong panel passwords make that address wait.
  - The panel cookie is `Secure` behind an HTTPS proxy.
  - The Host header is parsed strictly.
  - Short keys show no characters on Vory's env screen.
  - Updates are refused from `http://`/`git://` remotes.
  - `secrets.env` is created `0600`.
  - Approval cards from another machine start with "from \<machine\>:".

## Provider logins

Signing in to model providers from the panel (Logins tab) or `nhermes auth`, on this machine or a
member, through Pi's own login flows (`docs/LOGINS.md`):

- Automated:
  - Login sessions are tested with fake `Models` flows: device code, `secret` and `manual_code` prompts,
    failure, cancel, timeout, the 409/429 limits, redaction of answers and Pi errors, logout, and the
    `/admin/logins` API (`test/core/logins.test.ts`).
  - Remote sign-ins between two in-process gateways: TLS-PSK only, their own switch (off by default),
    refused on a replaced key, a member going offline mid-login. No credential or answer reaches the
    calling machine's responses or logs (`test/federation/logins.test.ts`).
  - OAuth refresh failures are recorded per provider, with one notification per episode (not repeated
    after a restart). Bots are marked in the panel state, and the mark clears on a working call or a new
    sign-in (`test/core/signin-failure.test.ts`).
- In panel-dev: the Logins tab, with fake providers on this machine and on a member, walked headless in
  light and dark. That covered device code to done, the paste step, cancel, sign out, resume after
  reload, and the switch-off message.
- Live (2026-10-21): two members were each signed in to xAI from a third machine's Logins tab, approving
  the device codes on a phone. Each machine saved its own login (their stored credentials differ), and the
  members logged the sign-in as started by the third machine.
- Not yet verified:
  - a callback provider's paste step
  - `nhermes auth` in a terminal
  - a real expired token

## Attachments from Vory

Pictures, PDFs and other files sent from Vory's composer (`src/core/attachments.ts`, `docs/COMPATIBILITY.md`):

- Automated (2026-10-21):
  - Uploads checked by their bytes, saved to `uploads/` without overwriting, names cleaned, size limits,
    pictures shrunk by Pi's Photon processor (`test/core/attachments.test.ts`, `test/core/images.test.ts`).
  - Over the wire: a message of only a picture, pictures queued behind a running turn, a CSV inlined and a zip
    noted, PDF pages through an injected renderer, `path` params refused, reopened chats showing Vory's marks,
    the "Picture" title, titles and previews without PDF lines or `@file:uploads/…` references
    (`test/hermes/attachments.test.ts`).
  - `GET /api/media` by Vory's guessed path, confined to the workspaces (`test/hermes/manage.test.ts`).
  - A member chat: the picture is staged on the member and reaches its model, alpha loads it back through the
    member; a member cannot upload into chats it did not start (`test/federation/proxy.test.ts`,
    `network.test.ts`).
  - pdftoppm itself was checked by hand on a Mac (two pages rendered); the suite does not need poppler.
- Not yet verified live: a photo, screenshot, PDF and CSV from the Vory app to a gateway on a vision model and
  a text-only one, and the thumbnails after reopening the chat.

## MCP servers

MCP servers as tool groups (`src/mcp/`, `docs/MCP.md`):

- Automated (2026-10-21), against a controllable Streamable HTTP MCP server (`test/mcp/server.ts`):
  - pi-mcp's error shapes for refused, dropped, timed-out, expired-session and failed requests, no resent
    POST, Durable swapping a re-installed extension's tools (`test/upstream/mcp-contract.test.ts`).
  - Connections (`test/mcp/connection.test.ts`): discovery and the snapshot kept across a restart, down at
    startup and used once back (the call's quick reconnect), noticed by the health check and logged once,
    backoff recovery, a server that never answers not holding up another, missing and refused keys,
    `tools/list_changed` and the change log, a changed URL, a 400 handshake (newer protocol) and the gateway's
    own URL refused, and call outcomes (expired session resent once; dropped, failed, rejected, timed-out and
    interrupted calls sent exactly once).
  - Config and Settings edits (`test/mcp/config.test.ts`), outcome classification (`test/mcp/outcome.test.ts`).
  - Tools in chats with the faux model (`test/mcp/tools.test.ts`): the `mcp:<server>` group and the prompt
    line, approvals for tools that are not read-only (and the policy by mode, trusted bots, glob rules), an
    offline server's tools staying declared with a "not sent" answer while other tools run, a dropped write
    reported as "may have run" and never resent, a changed tool list reaching chats, include/exclude and a
    disabled server, deferred tools found with `tool_search`, a key echoed by the server redacted, a
    restart mid-call (a write is interrupted, a read-only call runs again), and a hung call holding up only
    its own chat.
  - Management (`test/mcp/manage.test.ts`): the panel's and the admin API's add, view, edit, test and remove,
    404 for an unknown server, a credential header refused unless it references a key, a hand-written one
    hidden, key values never returned, and the doctor's lines.
  - Vory's MCP Servers routes (`test/mcp/vory.test.ts`): the list per profile in Vory's shape, the toggle as
    that bot's access, Test while up and down, Remove, 404s, and MCP groups on the Tools page.
  - Network (`test/federation/mcp.test.ts`): a member's MCP tools used by delegating to its bot (the call
    goes out from that machine with its key; a read-only call runs, a write's approval is answered in the
    caller's chat), and a member's servers managed from another panel and from Vory only once that machine
    allows bot edits, with no key value sent.
- Panel (panel-dev, 2026-10-21): the MCP tab in dark and light and at phone width, with servers online,
  offline and missing a key; the tool list, an edit saved, a credential header refused; a member's servers
  under "Other machines", and a member that does not allow edits shown as such. `nhermes mcp` list,
  show, add, test, disable and rm run against the same gateways.
- Not yet verified live against a real MCP server, nor on Vory's MCP Servers screen in the app.

## Models

All bots default to `neuralwatt/deepseek-v4.1-flash`. The VM and the Mac agent each have their own
`models.json` listing Neuralwatt's full library (27 models), generated with `scripts/neuralwatt-models.ts`;
the key is read from `NEURALWATT_API_KEY` in `secrets.env`. Sessions follow their bot's model unless a
chat picked its own in Vory. Neuralwatt is now a catalog provider (`src/models/neuralwatt.ts`): the key
alone brings its live list. Those `models.json` files still win while they define `neuralwatt`; remove
that entry (or the file, and `pi.modelsPath` with it) to switch a machine to the automatic list.

## Open items

- Pick a second VM for `ops` (real remote host) and, if wanted, move the Mac peer to a VM.
- Pushover keys for a live notification test.
- Drive an approval card and the cron screens in the Vory UI by hand once.
- Vory's settings and maintenance screens (Tools, Config, Env, Files, Analytics, update/restart/doctor, logs)
  are implemented, also for members' bots (`docs/REMOTE-BOT-EDITS.md`), and so are MCP servers
  (`docs/MCP.md`); Projects and bot rooms still answer 404 / -32601. See `docs/COMPATIBILITY.md`.
- Federation F5: Vory's E2E suite and a UI pass with a remote profile selected are not run yet
  (`docs/FEDERATION.md`).
- Hermes on the VM still runs on 9119. Stopping it is a later step (owner allowed it if needed).
