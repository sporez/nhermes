# nHermes

A small, self-hosted personal agent platform. [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
runs the agents; the gateway has its own client API ([docs/API.md](docs/API.md)), which the nHermes app for
Mac, iPhone and iPad speaks, and any other client can.

- **Bots** with their own instructions, model, tools, skills, memory and execution target; any number of
  chats per bot, plus job and delegation sessions.
- **Durable**: conversations, runs and scheduled jobs survive restarts and disconnects.
- **Approvals** enforced on the server for high-impact actions, answered from any device.
- **Skills** (standard `SKILL.md`), **memory** (per bot, explicit shared spaces, SQLite FTS5, and a new chat sees the bot's latest chats),
  **scheduled tasks** with history, notifications (Pushover), **delegation** between bots, **group chats**.
- **Remote hosts** over SSH (pi-env), and a **network of gateways**: machines join with a one-time code,
  every bot on every machine can delegate to the others, and a client connected to any machine lists them all.
- **Web control panel** at `/panel` on every gateway: bots (members' bots too), network, sessions, memory,
  keys, approvals and Jev permission review, software updates.
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
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Install, service, connecting the app, backup/restore, upgrade |
| [docs/API.md](docs/API.md) | The client API (`/api/v1`): operations, events, errors, how it grows |
| [docs/FEDERATION.md](docs/FEDERATION.md) | Network of gateways and the web panel |
| [docs/REMOTE-BOT-EDITS.md](docs/REMOTE-BOT-EDITS.md) | Editing members' bots from any panel or client |
| [docs/SECRETS-AND-REVIEW.md](docs/SECRETS-AND-REVIEW.md) | Keys in the panel and Jev permission review |
| [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md) | Browser and desktop automation |
| [docs/STATUS.md](docs/STATUS.md) | What is verified, and how |
| [docs/BACKLOG.md](docs/BACKLOG.md) | Phases and what is next |
| [UPSTREAM.md](UPSTREAM.md) | Pinned upstream versions |

Tests: `npm test` (faux model, no network), `npm run typecheck`. Live checks: `scripts/smoke.ts`,
`scripts/approval-smoke.ts`. Panel work: `scripts/panel-dev.ts` (two local gateways with a fake model).
Sample answers and event streams for a client's tests: `scripts/api-fixtures.ts`.
