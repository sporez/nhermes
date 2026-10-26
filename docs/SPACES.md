# Spaces (plan)

Status: in progress. Host setup and network isolation verified on the gateway VM (2026-10-25); the core
(S1), picture cards (P), the bot tools (S2) and the panel and doctor (S3) are automated-tested; not yet
tried by a bot on a real space.

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
  sensitive file on the bot's machine or read the gateway's own files. Work a network member started cannot open
  a space. Tool output goes through the same secret redaction as every tool's (the guard's `afterTool`).
- No live viewer: bots show the owner screenshots (`show {from}`). A viewer is deferred (see "Later").

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

## Steps

- [x] S0. Host setup, network isolation, spike (this document) (001ece9)
- [x] P. The bot can send the owner pictures: an `image` card through `show`, from a tool result's picture (any
  screenshot) or a picture file on the bot's host, kept as a chat attachment (9945420)
- [x] S1. `src/spaces/`: open, close, list, limits, idle deletion, sweep; tests with a fake `cua` (94aeefe)
- [x] S2. Desktop tools take `space`; `space_shell`, `space_copy` (no viewer card: bots show screenshots) (a0d4049, 95937c8)
- [x] S3. Panel: running spaces with a delete button; `doctor` checks `cua`, the runtime and the firewall (6a83adb)
- [ ] Later: VM spaces (image tools, network isolation), pools, a live viewer link card (access tickets are secrets)
