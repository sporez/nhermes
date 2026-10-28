# Spaces (plan)

Status: in progress. Host setup and network isolation verified on the gateway VM (2026-10-25); the core
(S1), picture cards (P), the bot tools (S2) and the panel and doctor (S3) are automated-tested; not yet
tried by a bot on a real space. The live viewer (V0-V3) is built: its checks passed on the gateway VM
(2026-10-27), the gateway side is automated-tested and was tried live against a real space; the app's side is not
built yet.

## Goal

A bot that needs a desktop opens a fresh, disposable one (a *space*), uses it, and throws it away. Most
bots never need one; some need one now and then, and occasionally two at once. Spaces are
[Cua](https://github.com/trycua/cua) sandboxes on the gateway host: Linux desktops started by the `cua`
CLI, ready in seconds.

Decided so far:

- **Transient, not per bot.** A space lives for one task. Nothing in it is kept.
- **On the gateway host.** Linux containers under gVisor first (see "Spike results" for why not VMs yet).
- **The bot stays where it is.** Its shell, files and workspace stay on its host. A space is a separate
  target its tools point at; a deleted space takes nothing of the bot's with it.
- **Cleanup is ours.** Cua does not expire local spaces (`--ttl` only applies to provider sandboxes), so
  nHermes deletes idle spaces and sweeps unclaimed ones at start and once a day.

## Design (as built)

- A `spaces` tool group (`src/tools/spaces.ts`): `space_open` creates a space and returns its id,
  `space_close` deletes it, `space_list` shows the bot's open spaces, `space_shell` runs a command in one and
  `space_copy` moves a file between a space and the bot's own machine (through the bot's execution environment,
  so it works for SSH-host bots too). The desktop tools (`src/tools/desktop.ts`) take an optional `space`
  argument and then run in that space on display `:1`; the group includes them. A bot without the `desktop` group
  is refused the host's desktop when `space` is missing, on the server. Usage: `docs/COMPUTER_USE.md` "Spaces".
- Control goes through pi-env, the same daemon remote hosts use: the first use of a space copies its `pi-env`
  binary into it and starts it with `cua sb exec -i <space> -- /tmp/pi-env` as the `Connection` command. No new
  control protocol.
- `src/spaces/` owns lifecycle, limits (per bot and per gateway), idle deletion and the sweep. Spaces are named
  `nhermes-<tag>-<bot>-<id>`, where `<tag>` is four hex characters of a hash of the gateway's data directory; the
  sweep deletes only names with its own `nhermes-<tag>-` prefix. `cua sb ls` is the only record of what exists.
  A call using a space counts it as in use (`Spaces.use`), and idle deletion skips it.
- Opening a space is an ordinary tool call under the bot's approval policy: `space_open`, `space_list`,
  `space_close`, `space_shell` and `space_copy` run in `smart` mode and ask in `manual` mode (the desktop tools
  follow their usual policy). `space_shell` is not scanned like `bash`: a space has no route to the LAN and is
  thrown away, so its commands (`sudo`, installs) are ordinary there; `space_copy` asks when it would write a
  sensitive file on the bot's machine, read the gateway's own files, or send a sensitive file into a space. Work
  a network member's bot started cannot open a space; the owner's own chat relayed from a member can (the app
  talks to one gateway at a time). Tool output goes through the same secret redaction as every tool's (the guard's `afterTool`).
- The owner watches a space live, or takes control of it, through Cua's own viewer served by the gateway (see "Live
  viewer"). Bots can still show a screenshot (`show {from}`).

## Host setup

On a Debian 13 host (what the gateway VM runs):

```sh
# Cua CLI only: no sign-in, no `cua host setup` (remote access through Cua's relay), telemetry off.
curl -fsSL https://cua.ai/install.sh -o /tmp/cua-install.sh     # read it first
mkdir -p ~/.cua && printf '[telemetry]\nenabled = false\n' >> ~/.cua/config.toml
DO_NOT_TRACK=1 sh /tmp/cua-install.sh --cli-only --no-onboarding --no-modify-path --no-skills

# Docker, with the gateway's user in the docker group (that group is root-equivalent).
sudo apt-get install -y docker.io && sudo usermod -aG docker "$USER"

# gVisor from gvisor.dev's apt repository (Cua 0.9.0's `cua runtime setup runsc` reports it present
# without installing it), registered with Docker.
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc && sudo runsc install && sudo systemctl restart docker

# QEMU, for VM spaces (optional today).
~/.local/bin/cua runtime setup qemu

~/.local/bin/cua runtime doctor     # container: "with gVisor (runsc)", qemu: ok
```

Then install the firewall below before any bot can open a space.

## Network isolation

Without it, a space reaches everything the host reaches: the gateway's own port, SSH, the hypervisor's
web UI, every other machine on the LAN. A bot browsing an untrusted page in a space must not.

`deploy/spaces-firewall.sh` adds two iptables chains for traffic from Docker's bridges (`docker0`,
`br-*`):

- `NHERMES-SPACES-FWD`, jumped to from `DOCKER-USER` (traffic a space sends through the host): replies to
  connections the space opened pass; DNS to the host's upstream resolvers passes (Docker hands containers
  those servers when the host uses a loopback stub such as systemd-resolved); anything else to
  `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` or `169.254.0.0/16` is dropped.
  The internet stays reachable.
- `NHERMES-SPACES-IN`, jumped to from `INPUT` (traffic a space sends to the host itself): only replies
  to connections the host opened, which is how `cua` controls a space through its published port.

`deploy/nhermes-spaces-firewall.service` is a system unit that runs the script after Docker starts and
again whenever Docker restarts (Docker does not keep rules added to `DOCKER-USER`). Its header has the
install commands. `nhermes-spaces-firewall status` prints the rules; `stop` removes them.

Limits:

- It covers every Docker container on the host, not only spaces.
- IPv4 only. Docker gives containers no IPv6 address unless configured to; revisit if that changes.
- It does not cover **VM spaces**. QEMU's user-mode network sends a VM's traffic as an ordinary process
  of the user that started it, which is also the gateway's user, so these rules cannot tell them apart.
  VM spaces need their own answer (a separate user for QEMU, or `--network none` where no internet is
  needed) before bots use them.

Verified on the gateway VM (2026-10-25): from a new space, DNS and `https://example.com` work; the
gateway's port through the host's LAN address and through the bridge address, the hypervisor's web UI,
the router and another LAN host all time out. `cua sb exec` and `cua sb screenshot` still work. After
`systemctl restart docker` the rules are back and the same checks pass. The gateway and the host's own
traffic are unaffected.

## Spike results (2026-10-25)

Cua 0.9.0 on the gateway VM: Debian 13, 4 vCPUs (i5-2400 era), 15 GiB, nested KVM available.

| | Container (gVisor) | VM (QEMU + KVM) |
|---|---|---|
| Image | `ghcr.io/trycua/linux:24.04`, 3.2 GB | `…:24.04-disk`, 2.7 GB |
| Ready (`--wait desktop`), image cached | 7.5 s | 3.9 s (restores a snapshot; 42 s the first time after a host reboot, 75 s on first download) |
| Two at once | 8.5 s and 8.9 s (17–19 s with 2 vCPUs) | not measured |
| Headless (`--headless`, no desktop) | 1.7 s | – |
| Delete | 0.5 s | 0.3 s |
| Memory | 257 MiB idle, 560 MiB with Chromium | about 330 MiB on the host |
| `cua sb exec` round trip | 0.3 s | 0.3 s |
| pi-env inside | connects in 0.2 s, commands 0.1–0.3 s | same |
| Desktop tools' programs | xdotool, wmctrl, ImageMagick, AT-SPI all present | xdotool and AT-SPI; no wmctrl or ImageMagick |

Through pi-env in a container space, the commands `src/tools/desktop.ts` runs opened a terminal, typed a
command (its output file was read back), opened Chromium on example.com, listed windows, read the
accessibility tree and took screenshots, unchanged. The desktop is `:1` (1280×800), the user `cua` with
sudo. No Mousepad; `xfce4-terminal`, Chromium and Firefox are there.

Why containers first: the desktop tools work in them as they are, and the firewall above covers them. VMs
start faster and isolate better, but need wmctrl and ImageMagick in the image and their own network
isolation.

Cua facts worth knowing:

- `cua sb exec -i` streams stdin and stdout (argv, no shell, no time limit), which is what pi-env needs.
- `cua sb rm` asks for confirmation unless given `-f`, and fails without a terminal.
- `cua sb pool` keeps spaces ready (about 0.1 s to take one) but needs the `cua daemon` running; not
  needed at today's start times.
- `cua daemon reap` ends VMs nobody uses and runs without a daemon, but does not touch containers.
- The Spaces desktop app (shared cursor, Teleport) is macOS 26+ only and not part of this.

## Live viewer

The owner watches a space live and can take control of it, from the app or the panel, through the one gateway
the app talks to, wherever the bot runs.

What Cua gives (read in Cua's source at its 0.9.0 command spec, and checked on the gateway VM, 2026-10-27):

- `cua sb view NAME --no-open --json [--view-only] [--ttl 15m] [--files none]` prints `{url, expires_at_unix}`:
  `http://127.0.0.1:<port>/viewer/#ticket=…`, the HTML5 viewer served by cua-spacesd inside the space on its
  `env` port (3211), published on the host's loopback.
- The ticket is HMAC-signed, scoped and expiring (60 s to 24 h, default 1 h), in the fragment so browsers never
  send it. `--view-only` is enforced by cua-spacesd (no input, clipboard, files or microphone). Deleting the
  space ends every ticket; there is no per-ticket revoke.
- The viewer is gRPC-web over `fetch` plus one WebSocket (`rcdp.v2`), every URL relative to the page's own
  directory: no WebRTC, no UDP, and it works under any path prefix. H.264 where the browser decodes it, PNG
  frames otherwise.
- Cua's own sharing (`cua share`, `cua spaces share`, `sb url --public`) goes through Cua's relay and account,
  which this setup does not use.

Design:

Design (as built):

- **The bot never holds a link.** `space_view {space}` posts a `space` card that carries the space's id only, and
  the bot carries on. Opening the card calls `sessions.viewSpace {id, space, control?}` (`docs/API.md` "Watching a
  space"), which mints a fresh ticket each time, so no ticket reaches the model, the transcript or an event. The
  answer is a path relative to the gateway.
- **The gateway passes the viewer through** (`src/spaces/viewer.ts`). `Spaces.viewLink` asks `cua sb view` for the
  link and accepts only a viewer on this host's loopback. The main port serves `/spaces/view/<key>/…` by
  forwarding to that port, before any token check or JSON body handling: a browser opening a link cannot send the
  gateway token, so the key (random, 144 bits) and Cua's ticket are the credential. Only the viewer page
  (`GET /viewer…`), the gRPC methods a Cua viewer ticket may call, less the file ones, and the media socket
  (`/media`) pass; everything else (`/mcp`, `/files`, `/tunnel`, process and screenshot calls) is a 404 that never
  reaches the space. Only a short list of request headers passes: cookies, authorization and forwarding headers
  never do. Paths are never logged (the media socket's query holds a ticket).
- **The page runs sandboxed.** The viewer page comes from inside the space, which bots use freely (`sudo`,
  untrusted pages), so a tampered space could serve its own script. Served from the gateway's origin, that script
  could act as the panel. Every response carries `Content-Security-Policy: sandbox allow-scripts`, so the page
  runs in an opaque origin: it cannot read the gateway's cookies, and its requests to the panel's routes fail
  (the panel also refuses an `Origin: null` change). The viewer's own calls work through CORS headers the gateway
  adds on the view's routes only.
- **A member's bot, through the member.** For a chat with a member's bot, this gateway forwards
  `sessions.viewSpace` over the member link (`src/federation/chats.ts`). The member makes the view for that
  member, served as `/federation/spaces/view/<key>/…` on its encrypted port to that member only, and answers the
  path; this gateway serves it under its own key, forwarding HTTP and the WebSocket over TLS-PSK. A member's
  views close when it leaves. The app's link always points at the gateway it talks to.
- **Who may watch.** The owner, through this gateway's token or the panel; a member, for the chats it relayed
  (`sessions.viewSpace` is a chat's operation, so the usual chat rules decide).
- **Watching keeps a space.** The gateway that holds the space counts open media sockets per space
  (`Spaces.watch`). Idle deletion skips a space while one is open, and its idle clock restarts when the last
  closes. The bot's own `space_close` and gateway shutdown still delete it, and close its views.
- **Control.** `control: true` mints without `--view-only` and with `--files none`: mouse, keys and clipboard reach
  the space; files and microphone stay off. While a control view's socket is open (`Spaces.controlled`), the bot's
  desktop input in that space (click, type, key, scroll, focus, launch) is refused with a message saying the owner
  has taken control and to wait for them, and its screenshots, window and accessibility reads, `space_shell` and
  `space_list` say so too. Closing the view or switching to watching hands it back. The bot is told when it next acts
  in the space, not the moment the owner takes over: a message pushed into the chat would start a run of an idle
  bot. A control ticket still cannot start processes, take screenshots or
  read files: those methods are refused by cua-spacesd and are not on the gateway's list either.
- **Ticket lifetime.** Ten minutes (`VIEW_TTL_S`). A connected viewer keeps going past it; Cua's viewer reconnects
  a dropped socket with the same ticket until it expires, then ends. The gateway's key opens new connections
  until the ticket expires and lives on while one of its sockets is open.
- **The bot's open spaces stay in view.** A space is the bot's, not one chat's. `sessions.spaces` lists the chat's
  bot's open spaces, and every followed chat with that bot gets `spaces.changed` with the whole list when a space
  opens or closes or a view of one does (`Spaces.onChanged`, published to the bot's followed chats in
  `src/app.ts`). It is a chat event, so a member's bot's list reaches this gateway over the link that already
  carries that chat's events. The app pins each open space, with Watch and Control, at the top of Activity in every
  chat with the bot, and drops it the moment it closes. The owner can close one from there (`sessions.closeSpace`) or
  from the panel; the bot, if it names that space again, is told the owner closed it.
- **App.** The `space` card with Watch and Take control, opening the path in a full-screen web view, and the pinned
  spaces above.
- **Secure page.** The viewer uses fast video (H.264 through WebCodecs), audio and the clipboard only on a secure
  page. Through a gateway address on plain HTTP (not `localhost`) it falls back to PNG frames with no audio or
  clipboard; through HTTPS (a reverse proxy) it gets all of them.

Checks on the gateway VM (2026-10-27, Cua 0.9.0, a `linux` container space):

1. A container space's cua-spacesd has a root token: every call without one, `Health` included, is refused
   (`grpc-status 16`, "missing or invalid bearer token"); the media socket answers 401. A watch-only ticket calling
   `Screenshot` or `CreateViewerTicket` is refused (`grpc-status 7`); the viewer page itself is open.
2. `cua sb view --view-only --no-open --ttl 10m --json` answers `{"url": "http://127.0.0.1:<port>/viewer/#ticket=…
   &clipboard=0", "expires_at_unix": …}`; without `--view-only`, the same without `clipboard=0`. Ports are
   published on `127.0.0.1` only.
3. Through a path prefix (`/spaces/view/<key>/`) with the sandbox header, WebKit (Safari's engine) and Chromium
   show the live desktop (the media socket streams), the page's origin is `null`, `document.cookie` throws and a
   fetch to `/panel/api/status` fails. With a watch-only ticket a click does nothing; with a control ticket a
   click on the dock opened a terminal. The same then held through the real gateway code (`src/spaces/viewer.ts`)
   with `cua` run on the VM over SSH: the viewer counted while open, 0 after, and a 404 once the space closed.
4. CPU: a space nobody has watched idles at about 3% of a core. Once watched, cua-spacesd and PipeWire keep about
   45-80% of a core busy after the viewer has gone (the media session, audio included, lives until its ticket
   expires) and drop to 0.1% when it does. Hence the ten-minute ticket.

## Steps

- [x] S0. Host setup, network isolation, spike (this document) (001ece9)
- [x] P. The bot can send the owner pictures: an `image` card through `show`, from a tool result's picture (any
  screenshot) or a picture file on the bot's host, kept as a chat attachment (9945420)
- [x] S1. `src/spaces/`: open, close, list, limits, idle deletion, sweep; tests with a fake `cua` (94aeefe)
- [x] S2. Desktop tools take `space`; `space_shell`, `space_copy` (no viewer card: bots show screenshots) (a0d4049, 95937c8)
- [x] S3. Panel: running spaces with a delete button; `doctor` checks `cua`, the runtime and the firewall (6a83adb)
- [x] V0. The four checks under "Live viewer" on the gateway VM
- [x] V1-V3, gateway side: `sessions.viewSpace` (watch and control), the pass-through route, the `space` card and
  `space_view`, watching skips idle deletion, a member's bot through its member, panel Watch and Take control
- [x] V4. App: the `space` card, Watch and Take control in a full-screen web view
- [x] V5. A bot's open spaces pinned in every chat with it: `sessions.spaces`, `spaces.changed`, and the app's
  pinned cards
- [x] V6. The owner closes a space from its pinned card (`sessions.closeSpace`); the bot is told who closed it
- [x] The bot is told when the owner has taken control: its input in the space is refused while a control view is
  open, and its reading calls say so
- [ ] Later: VM spaces (image tools, network isolation), pools
