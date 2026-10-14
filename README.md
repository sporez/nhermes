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
- **Remote hosts** over SSH (pi-env) and **independent peer agents** on other machines.
- **Computer use**: Playwright browser, X11 desktop control.

```sh
npm ci && bin/nhermes init . && $EDITOR config.yaml secrets.env && bin/nhermes serve
```

| Doc | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design and trade-offs |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Install, service, Vory, backup/restore, upgrade |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Hermes/Vory feature matrix |
| [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md) | Browser and desktop automation |
| [docs/STATUS.md](docs/STATUS.md) | What is verified, and how |
| [UPSTREAM.md](UPSTREAM.md) | Pinned upstream versions |

Tests: `npm test` (faux model, no network), `npm run typecheck`. Live checks: `scripts/smoke.ts`,
`scripts/approval-smoke.ts`, `scripts/vory-e2e.sh` (stock Vory's own E2E suite).
