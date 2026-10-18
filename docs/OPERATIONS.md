# Operations

One process, `nhermes serve`, owns everything: the Hermes-compatible API, the scheduler, and two
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

# Config
mkdir -p ~/.config/nhermes && ~/nhermes/bin/nhermes init ~/.config/nhermes
$EDITOR ~/.config/nhermes/config.yaml    # bots, model, port (see deploy/config.example.yaml)
$EDITOR ~/.config/nhermes/secrets.env    # NHERMES_TOKEN (generated), provider keys, PUSHOVER_*
```

Model credentials: put provider keys in `secrets.env` (`CEREBRAS_API_KEY=…`, `OPENROUTER_API_KEY=…`), or
point `pi.authPath` / `pi.modelsPath` at a Pi `auth.json` / `models.json` (subscriptions and custom
OpenAI-compatible endpoints such as a local server).

Catalog providers need only their key. Set `NEURALWATT_API_KEY` (Keys tab, Vory or
`nhermes secret set NEURALWATT_API_KEY`) and the gateway fetches Neuralwatt's model list at once, offers
it in the pickers as `neuralwatt/<model>`, refreshes it every 12 hours and keeps the last list for starts
without the network; removing the key withdraws the models. No restart, no `models.json`. A provider
that `models.json` defines itself is left to that file, so delete its entry there to switch to the
automatic list. Adding another such provider is one adapter in `src/models/` (see `neuralwatt.ts`), listed
in `CATALOGS` in `src/models/catalogs.ts`. `scripts/neuralwatt-models.ts` still prints a `models.json`
for the Pi CLI. A bot's `model:` in config is its default;
its chats follow it unless one was switched in Vory. Sharing them with a running Pi CLI is
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

## Connect Vory

Vory → Settings → Gateways → Add: URL `http://<host>:9119` (or the Tailscale name / an HTTPS reverse
proxy), authentication **Session token**, token = `NHERMES_TOKEN`. Keep the port off the internet: use
Tailscale or a TLS proxy. Wrong tokens get HTTP 401 / WebSocket close 4401.

### Notifications in Vory

Vory → Settings → Notifications: allow notifications, then set up the Companion and install it on the
gateway. No gateway restart is needed. The gateway doesn't run the Companion's Python; it sends the same
notifications itself through the Vory push relay, which only sees encrypted payloads. You get approvals
with Approve once / Deny, finished and failed turns, scheduled-task results and the `notify` tool, and the
turn's Live Activity is finished. The test button in the setup sends a real push. The device registrations
and the Companion's files are kept in `<data>/vory/`. Pushover keeps working alongside it when its keys are
set. In a network, set it up on the gateway Vory connects to: that gateway notifies for chats with other machines' bots too, and the machine running the bot stays quiet for them. Scheduled tasks and the `notify` tool notify from the machine they run on, so set it up there too (or use Pushover) to get those. Removing the Companion in Vory stops the notifications. This needs a Vory build with the push relay
built in. A build without it asks for your own APNs key instead, and the gateway doesn't support that setup.

### Group chats in Vory

In Vory, start a new chat and add two to six bots: they share one group chat. Each message goes to the
bots it @mentions (`@ops`), or to all of them when it mentions none (`@all` and `@everyone` work too).
They answer one at a time, may pull each other in with `@name`, and stay quiet when they have nothing
to add. You get one notification when they are done. A bot that needs your approval shows "<bot> is
waiting for your approval" in the room; the approval notification opens that bot's own room session
with the card, and while the approval waits that session ("Group: <name>") is also at the top of Chats. Deleting the group in Vory disbands it (a running turn is stopped; the log stays in
`app.sqlite`). Group chats take the bots of the gateway Vory is connected to, not other machines' bots.

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
From Vory you can edit a bot's instructions, description, default model, reasoning, approval mode, "always
allowed" rules, tool groups, skills and scheduled tasks; create and remove bots; set and clear keys (not
the gateway token); check for updates, update and restart the gateway; run the doctor and read recent
logs; see usage analytics; and browse the bots' workspaces read-only (`docs/COMPATIBILITY.md`).

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
token; Gateway → Connect a client shows the addresses to enter in Vory and the token on request.

## Keys and tokens

`secrets.env` holds the gateway token and API keys. Manage it from the panel's Keys tab or with
`nhermes secret list`, `nhermes secret set NAME` (asks for the value without showing it) and
`nhermes secret rm NAME`. Values are never shown again; changes apply at once except the gateway token
and Pushover keys, which need a restart. A variable set by the service's own environment (for example in
the systemd unit) wins over the file and is read-only here. "Generate new token" shows a new gateway
token once: update Vory and restart the gateway. A key can also be set on other machines in the network,
on those whose panel allows "Accept keys from other machines" (off by default).

## Permission review (Jev)

With `OPENROUTER_API_KEY` set (Keys tab), the approval guard asks Jev before showing an approval card:
a confident allow (default 80%) runs without a card; otherwise the card shows Jev's view. While it is on,
the guard also asks about more everyday commands (deleting files, git writes, ssh/rsync, inline scripts,
containers, services), which Jev mostly answers. Never left to Jev: the destructive group (disk wipes and
checks, power, credentials…), your own `approvals.ask` rules, manual mode, scheduled jobs set to ask,
and work started by another machine. Commands and your recent messages in that chat go to
OpenRouter/TypeSafe, with known secrets removed. Settings: Gateway tab or `review: { jev: { enabled,
allowThreshold, timeoutMs, keyEnv } }` in config.yaml. Every review is listed in the panel's Status tab.

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
  them. The panel (Network) shows the port and whether each member is encrypted.
- A gateway that moves (another port or IP) tells the other members by itself on its next tick.
- "Let other machines edit this machine's bots" (Network tab, off by default) lets the other members'
  panels, and Vory connected to them, change this machine's bots (`docs/REMOTE-BOT-EDITS.md`).

## Data

`dataDir` (default `data/` next to the config; the VM uses `~/.local/share/nhermes`):

| Path | Contents |
|---|---|
| `durable.sqlite` | Pi Durable: conversations, runs, tool tasks (owned by Pi Durable) |
| `app.sqlite` | sessions catalogue, memory (FTS5), jobs and run history, approval rules, audit log |
| `workspaces/<bot>/` | each local bot's working directory |
| `browser/<bot>/` | browser profile (cookies, logins) and screenshots — treat as sensitive |
| `ssh/known_hosts` | pinned host keys for remote bots |
| `vory/` | Vory push device registrations and the Companion's stored files |

## Backup, restore, upgrade

- Backup: `nhermes backup` (cron it, e.g. a systemd timer, and copy the file off the machine). Secrets are
  excluded unless `--secrets`.
- Restore: `systemctl --user stop nhermes && nhermes restore file && systemctl --user start nhermes`.
- Upgrade: the panel's Gateway tab → Software → "Update now", or `nhermes update` (`--check` lists what
  is new; `nhermes update rollback` goes back to the version before). It fast-forwards the git checkout,
  reinstalls packages when the lockfile changed, and restarts through systemd/launchd; it refuses local
  changes or a version that needs a newer Node (then rerun the install script). By hand:
  `git pull && npm ci --omit=dev && systemctl --user restart nhermes`. `app.sqlite` migrations run
  forward automatically at start (`schema_version`); Pi Durable migrates its own store. Take a backup
  first; the five Pi packages are pinned together (see `UPSTREAM.md`) and `npm run test:upstream` checks
  the API we rely on after a bump.
- Interrupted work: runs and scheduled jobs in progress continue after a restart. A tool call that was
  executing is not repeated unless it is read-only; the model is told it was interrupted.

## Health

`GET /api/health` (no auth) answers `{ok:true}`; `GET /api/status` adds running sessions. The service
restarts on failure (`Restart=on-failure`). If Pi Durable's store fails, the process logs
`durable session failed` and should be restarted.
