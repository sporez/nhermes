# Neil Hermes

A small, self-hosted personal agent platform. [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
runs the agents; the gateway speaks the Hermes dashboard protocol, so the stock
[Vory](https://github.com/matt0975/vory) iPhone/iPad app is its client.

- **Bots** with their own instructions, model, tools, skills, memory and execution target; any number of
  chats per bot, plus job and delegation sessions.
- **Durable**: conversations, runs and scheduled jobs survive restarts and disconnects.
- **Approvals** enforced on the server for high-impact actions, answered from Vory.
- **Skills** (standard `SKILL.md`), **memory** (per bot, explicit shared spaces, SQLite FTS5),
  **scheduled tasks** with history and Pushover notifications, **delegation** between bots.
- **Remote hosts** over SSH (pi-env), and a **network of gateways**: machines join with a one-time code,
  every bot on every machine can delegate to the others, and Vory on any machine lists them all.
- **Web control panel** at `/panel` on every gateway: bots, network, sessions, memory, approvals.
- **Computer use**: Playwright browser, X11 desktop control.

Install or upgrade on Linux or macOS (no root; sets up a systemd user service or a launchd agent):

```sh
curl -fsSL https://raw.githubusercontent.com/sporez/nhermes/main/scripts/install.sh | sh
# add a machine to an existing network in the same step:
curl -fsSL https://raw.githubusercontent.com/sporez/nhermes/main/scripts/install.sh | sh -s -- --join <code>
```

Then give it a model (`~/.config/nhermes/config.yaml` and `secrets.env`) and open `http://<machine>:9119/panel/`.
By hand: `npm ci && bin/nhermes init . && $EDITOR config.yaml secrets.env && bin/nhermes serve`.

| Doc | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design and trade-offs |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Install, service, Vory, backup/restore, upgrade |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Hermes/Vory feature matrix |
| [docs/FEDERATION.md](docs/FEDERATION.md) | Network of gateways and the web panel |
| [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md) | Browser and desktop automation |
| [docs/STATUS.md](docs/STATUS.md) | What is verified, and how |
| [UPSTREAM.md](UPSTREAM.md) | Pinned upstream versions |

Tests: `npm test` (faux model, no network), `npm run typecheck`. Live checks: `scripts/smoke.ts`,
`scripts/approval-smoke.ts`, `scripts/vory-e2e.sh` (stock Vory's own E2E suite). Panel work:
`scripts/panel-dev.ts` (two local gateways with a fake model).
