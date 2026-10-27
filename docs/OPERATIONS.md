# Operations

One process, `nhermes serve`, owns everything: the client API, the Hermes-compatible API, the scheduler, and two
SQLite files. Tested on Debian 13 (the hermes VM) and macOS.

## Install with the script (Linux or macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/sporez/nhermes/main/scripts/install.sh | sh -s -- [--join <code>] [--name <machine>] [--port <port>]
```

`scripts/install.sh` installs Node 24 in `~/.local` when the system has none, puts the code in
`~/nhermes`, writes a starter config in `~/.config/nhermes` (data in `~/.local/share/nhermes`) the first
time, and runs the gateway as a systemd user service (Linux) or a launchd agent (macOS,
`com.nhermes.gateway`, logs in `~/Library/Logs/nhermes.log`). With `--join` it joins the network the code
comes from. Running it again upgrades the code and restarts the service; config and data stay. An
existing `~/nhermes` that is not a git checkout is moved aside first. Afterwards, set the model and its
key (below) and reload.

## Install by hand (Debian/Ubuntu, as an unprivileged user)

```sh
# Node 24 (official build, user-local)
cd ~/.local && curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz | tar xJ
export PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH

# Code
git clone https://github.com/sporez/nhermes ~/nhermes && cd ~/nhermes && npm ci --omit=dev

# Optional features
sudo apt-get install -y google-chrome-stable      # or: npx playwright-core install --with-deps chromium
sudo apt-get install -y xdotool imagemagick wmctrl python3-pyatspi at-spi2-core   # desktop control
sudo apt-get install -y poppler-utils             # PDFs sent from the app reach the model as page pictures (doctor warns without it)

# Config
mkdir -p ~/.config/nhermes && ~/nhermes/bin/nhermes init ~/.config/nhermes
$EDITOR ~/.config/nhermes/config.yaml    # bots, model, port (see deploy/config.example.yaml)
$EDITOR ~/.config/nhermes/secrets.env    # NHERMES_TOKEN (generated), provider keys, PUSHOVER_*
```

Model credentials: put provider keys in `secrets.env` (`CEREBRAS_API_KEY=…`, `OPENROUTER_API_KEY=…`), or
point `pi.authPath` / `pi.modelsPath` at a Pi `auth.json` / `models.json` (subscriptions and custom
OpenAI-compatible endpoints such as a local server).

Catalog providers need only their key. Set `NEURALWATT_API_KEY` (Keys tab, the client API or
`nhermes secret set NEURALWATT_API_KEY`) and the gateway fetches Neuralwatt's model list at once, offers
it in the pickers as `neuralwatt/<model>`, refreshes it every 12 hours and keeps the last list for starts
without the network; removing the key withdraws the models. No restart, no `models.json`. A provider
that `models.json` defines itself is left to that file, so delete its entry there to switch to the
automatic list. Adding another such provider is one adapter in `src/models/` (see `neuralwatt.ts`), listed
in `CATALOGS` in `src/models/catalogs.ts`. `scripts/neuralwatt-models.ts` still prints a `models.json`
for the Pi CLI. A bot's `model:` in config is its default;
its chats follow it unless one was switched in the app. Sharing them with a running Pi CLI is
safe: Pi's credential store locks the file during OAuth refresh.

## Run as a service

systemd user unit (`deploy/nhermes.service`):

```sh
loginctl enable-linger $USER                     # keep user services running without a login
mkdir -p ~/.config/systemd/user && cp deploy/nhermes.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now nhermes
journalctl --user -u nhermes -f                  # JSON-lines logs, secrets redacted
```

Rootless Podman works the same way: run `node src/cli.ts serve` in a `node:24-bookworm` image with
`~/.config/nhermes` and the data directory mounted as volumes, behind a Quadlet `.container` unit.
The service is a single process; do not run two against one data directory.

## Connect the nHermes app

The nHermes app (Mac, iPhone, iPad) speaks the gateway's own client API at `/api/v1` (`docs/API.md`). In
its first-run screen or Settings, give the gateway's address (`http://<host>:9119`, the Tailscale name, or an
HTTPS reverse proxy) and the token (`NHERMES_TOKEN`). The token travels as `Authorization: Bearer`; a wrong
one gets HTTP 401 / WebSocket close 4401. Keep the port off the internet: use Tailscale or a TLS proxy. Any
other client can use the same API; `node scripts/api-fixtures.ts <folder>` records sample answers and event
streams from a throwaway gateway, for a client's tests.

### Notifications

The nHermes app gets push notifications straight from Apple: approvals (with Approve once and Deny on the
notification), a bot's questions, finished and failed turns, scheduled-task results, the `notify` tool and OpenChamber alerts. It
needs an APNs key from the Apple developer account the app is signed with (Certificates, Identifiers &
Profiles → Keys → a key with Apple Push Notifications service). Download its `.p8` file once, then:

```yaml
# config.yaml
push:
  apns:
    keyId: ABC123DEFG     # the key's Key ID
    teamId: XYZ987TEAM    # the account's Team ID
```

```sh
base64 < AuthKey_ABC123DEFG.p8 | tr -d '\n'   # copy what this prints
nhermes secret set APNS_AUTH_KEY                # paste it when asked (or set it in the panel's Keys)
nhermes reload
```

The app registers each device when it connects. Apple sees the notifications' text (the gateway removes
known secrets first). The doctor reports the key and the devices.

Pushover works alongside it, or alone: set `PUSHOVER_USER_KEY` and `PUSHOVER_APP_TOKEN` in `secrets.env` (or
Keys in the panel). In a network, a machine with no transport of its own forwards its notifications to a
member that has one, so one setup is enough; the gateway the app is connected to notifies for chats with
other machines' bots, and the machine running the bot stays quiet for them. A gateway that still held
Vory's notification registrations (`<data>/vory/`) removes them at its next start.

### Cards

A bot can show the owner a card in the app instead of a wall of text. Every bot has the `show` tool, whatever its
`tools:` list, and uses it in three ways, most specific first:

- **A result the app draws.** MacBridge's Calendar, Reminders, Contacts, Weather, Places, Travel time and status
  results, the scheduled-task tools' results and a fetched page end with a line that names the card, for example
  "(The owner can be shown this as a Weather card: show {from: ...})". Any other tool's result gets such a line when its
  shape is a list (an object holding one list of items that each have an `id` and a `title` or `name`) or plain facts
  (an object of up to 30 short values); anything else gets no line, so the bot puts what matters in its reply.
- **A card the bot builds** from what it found: a `chart` for numbers, then a `list`, `facts` or `links` card. A built
  list or links card that only repeats a result the bot could have shown as it is gets refused, with the handle to
  use instead.
- **A small diagram or layout** as `html`, last. The gateway removes scripts, frames, forms and remote content from it
  before it is kept, and the app draws what is left with scripts off and no network.

The owner sees the card with the bot's reply, and the bot is told what was shown, so it does not repeat it. Where the
app cannot draw a card (a notification, a scheduled task's summary, another bot's report, a group chat), the card's
caption stands in for it as `[Card: <caption>]`. Cards need an app that lists `cards` in the hello's `features`
(`docs/API.md` "Cards"). Nothing to configure.

### Questions

When a bot needs your choice before going on (which restaurant, which of two files), it asks with its `ask`
tool, which every bot has. The question appears in the app as a card under the bot's reply, in Waiting for You,
and as a notification; the bot waits, and carries on in the same turn once you answer. Typing a reply in the
chat answers it too. A question waits a day unless you answer, dismiss it or stop the run (`defaults:
questionTimeoutS` in `config.yaml`, in seconds; it applies at once), and in a scheduled task's run no longer
than the task's next occurrence. A bot on another machine asks through the machine your app is connected to,
like its approvals. Bots are told never to ask for passwords or keys; those are secrets (`nhermes secret set`).

### Group chats

A group chat is two to six bots sharing one log (`rooms.*` in `docs/API.md`; the app has no screen for it
yet). Each message goes to the bots it @mentions (`@ops`), or to all of them when it mentions none (`@all`
and `@everyone` work too). They answer one at a time, may pull each other in with `@name`, and stay quiet
when they have nothing to add. You get one notification when they are done. A bot that needs your approval
shows "<bot> is waiting for your approval" in the room; the approval is asked in that bot's own room
session, which is listed at the top of the chat list while it waits. Disbanding a group stops a running
turn; the log stays in `app.sqlite`. Other machines' bots in the network can join too (`@media-media`):
they answer on their own machine, and their approvals come to you here. A machine that is offline makes its
bot's turn fail; the others carry on.

## Administration

```sh
nhermes status                          # bots, running sessions, jobs, notifier
nhermes memory main [search words]      # list/search; `add <text>`, `rm <id>`
nhermes host trust ops                  # show a bot's SSH host key fingerprints, trust after you compare
nhermes backup [--out file] [--secrets] # consistent online backup (.tar.gz) made by the running gateway
nhermes restore file [--with-config]    # gateway must be stopped; previous data is kept aside
```

Bots, their tools, skills and hosts are edited in `config.yaml`, then applied with `nhermes reload` (or
`systemctl --user reload nhermes` / SIGHUP). Bots and `defaults` apply at once, including to existing
chats on their next message; `reload` lists anything that still needs a restart (server address, data
directory, time zone, approval timeout). A file that does not load is refused and the running
configuration stays. The admin API (`/admin/config`, `/admin/bots`, `/admin/gateway`) makes the same edits
and keeps the file's comments.
Through the client API (`docs/API.md`) a client can edit a bot's instructions, description, default model,
reasoning, approval mode, "always allowed" rules, tool groups, skills and scheduled tasks; create and
remove bots; manage MCP servers; set and clear keys (not the gateway token); check for updates, update and
restart the gateway; run the doctor and read recent logs; see usage analytics; and browse the bots'
workspaces read-only. The nHermes app has screens for some of these so far (scheduled tasks, MCP servers);
the panel covers most of the rest.

Bots with the `self` tool group can make these edits too, each one shown to you as an approval card with
the change as a diff. Any such bot can change its own description, instructions, model, thinking, global
skill opt-ins and its own skills (`bots/<name>/skills`). A `trusted` bot can also edit, add and remove
other bots, change gateway defaults, time zone, ground rules, hidden model providers and Jev settings,
manage global skills, reload, and update or roll back the software. Never by a bot: secrets, tokens, the
panel password, the network, backups, host keys and shared memory spaces. Scheduled runs and work from
other machines cannot change settings. Before each bot-made edit the previous file is kept as
`config.yaml.prev`; to undo, copy it back and run `nhermes reload`. Each change is in the audit log.

## Web control panel

Every gateway serves a control panel at `http://<machine>:<port>/panel/` (the root URL redirects there):
bots with their settings, skills and system prompt (and other machines' bots under Remote bots, where
those machines allow it in their Network tab), the network (invite, join, remove), sessions, memory, keys,
pending approvals and the Jev review log, scheduled jobs, gateway settings and software updates. It is
open to anyone on the LAN until you set a password with `nhermes panel password` (or on its Gateway
screen); `nhermes panel password --clear` removes it. Set `panel: { enabled: false }` to turn it off, or
`server.host: 127.0.0.1` to keep the whole gateway on the machine. The panel never needs the gateway
token; Gateway → Connect a client shows the addresses to enter in the nHermes app and the token on request.

## Keys and tokens

`secrets.env` holds the gateway token and API keys. Manage it from the panel's Keys tab or with
`nhermes secret list`, `nhermes secret set NAME` (asks for the value without showing it) and
`nhermes secret rm NAME`. Values are never shown again; changes apply at once except the gateway token
and Pushover keys, which need a restart. A variable set by the service's own environment (for example in
the systemd unit) wins over the file and is read-only here. "Generate new token" shows a new gateway
token once: enter it in the app and restart the gateway. A key can also be set on other machines in the network,
on those whose panel allows "Accept keys from other machines" (off by default).

## Signing in to model providers

For providers that use a subscription or account login (xAI/Grok, ChatGPT, OpenAI Codex, GitHub Copilot,
Kimi, Anthropic and others), sign in without the `pi` CLI:

- `nhermes auth list` shows the providers, whether each is signed in, set by a key, or neither, and the
  last sign-in failure if there was one.
- `nhermes auth login <provider>` starts the provider's own sign-in on this gateway and prints what to do:
  a code and a link to approve on any device, or a link to open (when the browser ends on a page that
  cannot load, copy that page's address and paste it at the prompt). Keys and other prompts are typed without
  showing them. Ctrl-C cancels it. A login that is not finished is dropped after 10 minutes (or when the
  code expires).
- `nhermes auth logout <provider>` removes this machine's login.
- Add `--machine <member>` to any `auth` command to sign in another machine of the network. This gateway
  forwards the calls over the encrypted link (`/admin/remote/<member>/logins`); the code, link and prompts
  appear in your terminal, and the login is saved on that member. It works only when that member has
  "Let other machines sign this machine in to model providers" on (Network tab, off by default; separate
  from the keys and bot-edit switches). Otherwise it answers with that message.

The login is made by the running gateway and stored in `pi.authPath` on that machine (default
`~/.pi/agent/auth.json`, shared with the Pi CLI there); tokens never leave it. The provider's models show
up in the pickers at once, and leave when you log out. Providers that take only an API key are set under
Keys (`nhermes secret set`), not here. Plan: `docs/LOGINS.md`.

When a provider's sign-in can no longer be refreshed (the token was revoked or expired for good), a model
call on it fails with "OAuth refresh failed". The gateway then:

- shows the failure as the provider's last error in `nhermes auth list` and the Logins tab;
- sends one notification, "<Provider> on <machine> needs signing in again. Open the panel's Logins tab."
  (through the usual notifier, so a machine with no transport forwards it to a member that has one). It
  does not repeat until the provider has worked again or been signed in again, even across a restart;
- marks the bots that use that provider in the Bots tab ("Needs sign-in: <provider>", linking to Logins).
  The mark also shows for a provider that has no sign-in and no key at all. Both are read without the
  network. Members' bots are not marked.

Signing in again, or one successful model call on the provider, clears all three. An ordinary API error or
rate limit is not a sign-in failure.

## Permission review (Jev)

With `OPENROUTER_API_KEY` set (Keys tab), the approval guard asks Jev before showing an approval card:
a confident allow (default 80%) runs without a card; otherwise the card shows Jev's view. While it is on,
the guard also asks about more everyday commands (deleting files, git writes, ssh/rsync, inline scripts,
containers, services), which Jev mostly answers. Never left to Jev: the destructive group (disk wipes and
checks, power, credentials…), your own `approvals.ask` rules, manual mode, scheduled jobs set to ask,
and work another machine's bot started (your own chat relayed from the app on another member is reviewed
like a local one). Commands and your recent messages in that chat go to
OpenRouter/TypeSafe, with known secrets removed. Settings: Gateway tab or `review: { jev: { enabled,
allowThreshold, timeoutMs, keyEnv } }` in config.yaml. Every review is listed in the panel's Status tab.

## OpenChamber threads

The `openchamber` tool group lets a bot read and run the threads in OpenChamber on the same Mac:
`oc_sessions`, `oc_read`, `oc_waiting` and `oc_diff` read; `oc_approve`, `oc_answer`, `oc_stop`,
`oc_prompt` and `oc_start` act. It reads OpenChamber's port and token from
`~/.config/openchamber/settings.json` on every call, so a restarted OpenChamber needs nothing here; or
set `openchamber.url` and `openchamber.tokenEnv` (an environment variable or a key from `secrets.env`
holding the token) to reach it another way.

The control tools always ask the owner in smart and manual mode (YOLO and off skip asks as usual);
Jev never answers them. `oc_approve` is answered call by call, once or deny: no "always" answer covers
it. New threads use the default model, variant (thinking level) and agent picked in OpenChamber, read
at each start, so changing the default there is enough; `openchamber.model` (`provider/model`),
`openchamber.variant` and `openchamber.agent` override them for this bot.

The **OpenChamber Alerts** tool group (`openchamber_alerts`, no tools of its own) makes the gateway keep
one event subscription to OpenChamber and notify the owner when a thread asks for permission, asks a
question, or fails (not when it simply finishes, which would be every turn; delegated sub-threads are
skipped; at most one notification per thread and kind per minute). Switch it like any tool group, in the client API (`bots.update` tool groups) or in the panel; it starts
or stops at once, no restart. It reconnects quietly while OpenChamber is closed. It only listens: Jev
and the second-opinion reviewer decide before a permission card exists, and the watcher sees a card
only once they have passed it to the owner.

```yaml
  - name: chamber
    displayName: Chamber
    description: Reads and runs my OpenChamber threads
    tools: [openchamber, openchamber_alerts, memory, notify]
```

## Spaces

Bots can open disposable Linux desktops on the gateway host, through the `cua` command (host setup, the
firewall and the design: `docs/SPACES.md`). Nothing needs configuring when `cua` is on the `PATH`; every key is
optional:

```yaml
spaces:
  cua: cua           # the command, or its full path
  image: linux       # what `cua sb create` is given
  perBot: 2          # open spaces one bot may have
  total: 3           # open spaces on this gateway
  idleMinutes: 30    # an unused space is deleted after this long
```

The gateway keeps no record of spaces: at start and once a day it deletes every sandbox named `nhermes-<tag>-*`
that `cua sb ls` shows and it does not hold (`<tag>` is four hex characters of a hash of the gateway's data
directory, so two gateways on one host never delete each other's spaces), and closing the gateway deletes the open ones. Without `cua`, a bot
that tries to open a space is told the host needs it. A bot gets the tools from the **Spaces** tool group
(`spaces`, which also holds the desktop tools for use inside a space; `docs/COMPUTER_USE.md`). Work another
machine's bot started cannot open a space, but your own chat relayed through a member can; in `manual` approval mode each space tool asks.

The panel's Status tab lists the running spaces (bot, how long open, last used or "being watched") with Watch,
Take control and Delete buttons for each; Watch and Take control open the space's live desktop in a new tab. A bot
offers the same view in a chat with `space_view`, and the app opens it through the gateway it is connected to,
also for a member's bot (`docs/SPACES.md` "Live viewer"). The view is served on the main port under
`/spaces/view/` without the gateway token (its link carries its own key and ticket, valid for new connections for
ten minutes), so an HTTPS reverse proxy in front of the gateway needs to pass that path and WebSocket upgrades on it.
The section appears only while a space is open. The doctor (in the app, or the client API's `actions.start` with kind `doctor`) has a Spaces
section when `cua` is installed or a bot has the `spaces` tool group: it checks that `cua` runs, that containers
use gVisor (a warning if they would use plain runc), and that the `nhermes-spaces-firewall` unit is active
(on a host without systemd it says it cannot check). Each is a warning with what to do, never a failure.

## MCP servers

An MCP server that speaks Streamable HTTP can give tools to the bots you pick (`docs/MCP.md`). Each server is
a tool group `mcp:<name>`; a bot gets it by listing it under `tools:`, and no bot gets it by default.

```yaml
mcp:
  servers:
    calendar:                       # lower-case letters, digits and -
      url: https://mac.example.com:8443/mcp
      description: Calendar, reminders and contacts on my laptop   # shown to the bots and in the panel
      headers:
        Authorization: "Bearer {{secret:CALENDAR_MCP_TOKEN}}"     # the value lives in secrets.env (Keys)
      tools:
        readOnly: ["list_*", "get_*", "search_*"]  # these change nothing: no approval asked
        # include: ["*"]  exclude: []               # which tools are exposed at all
      # exposure: deferred   # many tools: bots find them with tool_search instead of seeing them all
      # timeoutS: 60   maxTimeoutS: 300   healthCheckS: 60   enabled: true   trustReadOnlyHint: false
bots:
  - name: helper
    tools: [memory, web, mcp:calendar]
```

- **Approvals.** A call to a tool that is not read-only asks first in smart mode (Jev may answer) and in
  manual mode, trusted bots included; `approvals.allow: ["tool:mcp__calendar__*"]` or an "always" answer
  lets it through. Read-only comes from you (`tools.readOnly`); `trustReadOnlyHint: true` also counts the
  server's own hints, which the MCP spec says are untrusted unless you trust the server.
- **Offline is normal.** The gateway starts and works whatever the servers do. A server that is away keeps
  its last known tools; a call to it fails within a few seconds and the bot is told the call was not sent.
  The gateway retries with backoff (up to every 5 minutes) and logs only when a server goes away or comes
  back. A call that may have reached the tool (the connection dropped after sending, or no answer in time)
  is never repeated automatically; the bot is told it may or may not have run.
- **Keys.** Put the token in Keys (`nhermes secret set CALENDAR_MCP_TOKEN`); setting it reconnects the
  server. A refused key shows as "needs a key" and is retried every 30 minutes or when the key changes.
- **Protocol.** The client is Pi's and speaks MCP 2025-11-25 (with an `initialize` handshake). A server that
  speaks only the newer stateless 2026-07-28 is shown as set up wrong; most SDKs serve both.
- Plain `http://` to another machine works, with a warning: the headers travel unencrypted unless the
  network encrypts them (Tailscale, WireGuard). Changes to `mcp.servers` apply at once, no restart.
- **Panel, MCP tab:** each server's state (online, offline since…, needs a key, set up wrong, turned off),
  its tools with their approval (read-only or asks first) and the server's own descriptions, what changed in
  its tool list and when, and Add / Edit / Test / Refresh tools / Turn off / Remove. Give a bot a server in the
  Bots tab (tool group `mcp:<name>`). Header values are typed as `{{secret:NAME}}`; a credential typed
  directly is refused, and one written into config.yaml by hand is never shown.
- **CLI:** `nhermes mcp` lists the servers; `nhermes mcp show <name>` shows one with its tools and changes;
  `nhermes mcp add <name> --url … [--header 'Authorization=Bearer {{secret:NAME}}'] [--read-only 'list_*']
  [--description …] [--exposure deferred]`, `edit`, `test`, `refresh`, `enable`, `disable` and `rm` do the rest.
  The doctor (the client API's `actions.start` with kind `doctor`) lists each server; one that is away is a warning, never a failure.

## Network of gateways

Every machine runs the same gateway; together they form one network of equals (`docs/FEDERATION.md`).

- Add a machine: on any member run `nhermes invite`, then on the new machine `nhermes join <code>` and
  confirm. The code works once, for ten minutes. The new machine is introduced to every other member.
- `nhermes members` lists the members and whether they answer; `nhermes members remove <name>` removes
  one from the whole network; `nhermes leave` takes this machine out.
- Members find each other at `node.url` (config) or, without it, the machine's LAN address and port.
  Set `node.url` when that guess is wrong (several interfaces, Tailscale only). `node.name` defaults to
  the host name.
- Members talk encrypted on a second port: the main port + 1000 (10119 with the default 9119), or the
  next free one, or `server.federationPort`. Open it between the machines if a firewall sits between
  them. The panel (Network) shows the port and whether each member is encrypted. Members talk only
  encrypted: a machine on a version without the encrypted port must be updated before it can join, and
  a member the panel marks "No encrypted link" must be removed and joined again.
- A gateway that moves (another port or IP) tells the other members by itself on its next tick.
- "Let other machines edit this machine's bots" (Network tab, off by default) lets the other members'
  panels, and the app connected to them, change this machine's bots (`docs/REMOTE-BOT-EDITS.md`) and its MCP
  servers (the MCP tab's "Other machines"; key values stay here, see `docs/MCP.md`).
- "Let other machines sign this machine in to model providers" (Network tab, off by default) lets the other
  members' panels and `nhermes auth --machine` start, answer and cancel provider sign-ins here, and sign
  this machine out (`docs/LOGINS.md`). The sign-in is saved on this machine; no token is sent to them.

## Data

`dataDir` (default `data/` next to the config; the VM uses `~/.local/share/nhermes`):

| Path | Contents |
|---|---|
| `durable.sqlite` | Pi Durable: conversations, runs, tool tasks (owned by Pi Durable) |
| `app.sqlite` | sessions catalogue, memory (FTS5), jobs and run history, approval rules, audit log |
| `workspaces/<bot>/` | each local bot's working directory; `uploads/` in it holds what was sent from a client, each upload with its id (kept until removed by hand) |
| `browser/<bot>/` | browser profile (cookies, logins) and screenshots — treat as sensitive |
| `ssh/known_hosts` | pinned host keys for remote bots |

## Backup, restore, upgrade

- Backup: `nhermes backup` (cron it, e.g. a systemd timer, and copy the file off the machine). A backup holds
  chat transcripts and the bots' browser logins, so it is written owner-only (mode 0600); keep it that way
  when you copy it. Secrets (`secrets.env`, and the keys you share with other members) are excluded unless
  `--secrets`; without it, members must join again after a restore. The panel password is kept either way.
- Restore: `systemctl --user stop nhermes && nhermes restore file && systemctl --user start nhermes`.
- Upgrade: the panel's Gateway tab → Software → "Update now", or `nhermes update` (`--check` lists what
  is new; `nhermes update rollback` goes back to the version before). It fast-forwards the git checkout,
  reinstalls packages when the lockfile changed, and restarts through systemd/launchd; it refuses local
  changes or a version that needs a newer Node (then rerun the install script). By hand:
  `git pull && npm ci --omit=dev && systemctl --user restart nhermes`. `app.sqlite` migrations run
  forward automatically at start (`schema_version`); Pi Durable migrates its own store. Take a backup
  first; the six Pi packages are pinned together (see `UPSTREAM.md`) and `npm run test:upstream` checks
  the API we rely on after a bump.
- Interrupted work: runs and scheduled jobs in progress continue after a restart. A tool call that was
  executing is not repeated unless it is read-only; the model is told it was interrupted.

## Health

`GET /api/health` (no auth) answers `{ok: true, version}`; `nhermes status` adds running sessions and jobs. The service
restarts on failure (`Restart=on-failure`). If Pi Durable's store fails, the process logs
`durable session failed` and should be restarted.
