# Operations

One process, `nhermes serve`, owns everything: the Hermes-compatible API, the scheduler, and two
SQLite files. Tested on Debian 13 (the hermes VM) and macOS.

## Install (Debian/Ubuntu, as an unprivileged user)

```sh
# Node 24 (official build, user-local)
cd ~/.local && curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz | tar xJ
export PATH=$HOME/.local/node-v24.21.0-linux-x64/bin:$PATH

# Code
git clone <this repo> ~/nhermes && cd ~/nhermes && npm ci --omit=dev

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
OpenAI-compatible endpoints such as Neuralwatt or a local server). For Neuralwatt's whole library:
`NEURALWATT_API_KEY=… node scripts/neuralwatt-models.ts > ~/.config/nhermes/models.json` (rerun when they
add models; the file holds `$NEURALWATT_API_KEY`, not the key). A bot's `model:` in config is its default;
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

Vory → Settings → Gateways → Add: URL `http://<host>:9120` (or the Tailscale name / an HTTPS reverse
proxy), authentication **Session token**, token = `NHERMES_TOKEN`. Keep the port off the internet: use
Tailscale or a TLS proxy. Wrong tokens get HTTP 401 / WebSocket close 4401.

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
From Vory you can edit a bot's instructions, description, default model, skills and scheduled tasks.

## Network of gateways

Every machine runs the same gateway; together they form one network of equals (`docs/FEDERATION.md`).

- Add a machine: on any member run `nhermes invite`, then on the new machine `nhermes join <code>` and
  confirm. The code works once, for ten minutes. The new machine is introduced to every other member.
- `nhermes members` lists the members and whether they answer; `nhermes members remove <name>` removes
  one from the whole network; `nhermes leave` takes this machine out.
- Members find each other at `node.url` (config) or, without it, the machine's LAN address and port.
  Set `node.url` when that guess is wrong (several interfaces, Tailscale only). `node.name` defaults to
  the host name.

## Data

`dataDir` (default `data/` next to the config; the VM uses `~/.local/share/nhermes`):

| Path | Contents |
|---|---|
| `durable.sqlite` | Pi Durable: conversations, runs, tool tasks (owned by Pi Durable) |
| `app.sqlite` | sessions catalogue, memory (FTS5), jobs and run history, approval rules, audit log |
| `workspaces/<bot>/` | each local bot's working directory |
| `browser/<bot>/` | browser profile (cookies, logins) and screenshots — treat as sensitive |
| `ssh/known_hosts` | pinned host keys for remote bots |

## Backup, restore, upgrade

- Backup: `nhermes backup` (cron it, e.g. a systemd timer, and copy the file off the machine). Secrets are
  excluded unless `--secrets`.
- Restore: `systemctl --user stop nhermes && nhermes restore file && systemctl --user start nhermes`.
- Upgrade: `git pull && npm ci --omit=dev && systemctl --user restart nhermes`. `app.sqlite` migrations run
  forward automatically at start (`schema_version`); Pi Durable migrates its own store. Take a backup
  first; the five Pi packages are pinned together (see `UPSTREAM.md`) and `npm run test:upstream` checks
  the API we rely on after a bump.
- Interrupted work: runs and scheduled jobs in progress continue after a restart. A tool call that was
  executing is not repeated unless it is read-only; the model is told it was interrupted.

## Health

`GET /api/health` (no auth) answers `{ok:true}`; `GET /api/status` adds running sessions. The service
restarts on failure (`Restart=on-failure`). If Pi Durable's store fails, the process logs
`durable session failed` and should be restarted.
