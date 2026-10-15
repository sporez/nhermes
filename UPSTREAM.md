# Upstream pins

Reference clones live in `reference/` (git-ignored, read-only). Re-create them with
`scripts/fetch-upstream.sh`, which checks out exactly these commits.

| Project | Repository | Pinned commit | Commit date | Recorded | License |
|---|---|---|---|---|---|
| Pi (incl. Pi Durable) | https://github.com/earendil-works/pi | `06a466935536f8c9bcacb2d5efc0fc021be1bdff` (tag `v1.2.0`) | 2026-10-13 | 2026-10-14 | MIT (Mario Zechner) |
| Hermes Agent | https://github.com/NousResearch/hermes-agent | `300228d24c593f779055204753921fbe9a2163c5` | 2026-10-14 | 2026-10-14 | MIT (Nous Research) |
| Vory | https://github.com/matt0975/vory | `d99369bfdb64a29cae5aa7776fc13fd6ee5c152e` | 2026-10-09 | 2026-10-14 | MIT (Matthew Wagner) |

`src/core/review.ts` adapts the permission-review rules and Jev request handling of the owner's
OpenChamber plugin `opencode-auto-permissions` (0.2.15-openchamber.jev.3, local), itself based on
https://github.com/hueyexe/opencode-auto-permissions (MIT). Jev: TypeSafe AI's `~typesafe/jev-latest`
through OpenRouter's `/api/alpha/decisions`.

Pi `main` was at `b45e0ebc` (17 commits past `v1.2.0` in the packages we use) when it was cloned. We pin the
tag because it is what npm publishes; reading `main` would describe code we do not run.

## npm packages (exact versions, no ranges)

| Package | Version | Why we use it |
|---|---|---|
| `@earendil-works/pi-durable` | 1.2.0 | Agent engine: durable conversations, generation/tool tasks, SQLite storage, events, compaction, subagent ownership |
| `@earendil-works/pi-ai` | 1.2.0 | Model/provider layer used by Durable (`Models`) |
| `@earendil-works/chord` | 1.2.0 | `Context` / cancellation that every Durable call takes |
| `@earendil-works/pi-coding-agent` | 1.2.0 | `ModelRuntime` (reads Pi's `auth.json` + `models.json`, OAuth refresh under a file lock) and the SKILL.md loader |
| `@earendil-works/pi-env` | 1.2.0 | `RemoteExecutionEnv` over SSH (Mode A remote execution) |

All five come from the same Pi release and must be upgraded together. `test/upstream/` holds the
regression tests that pin the parts of their API we rely on; run them first after a bump.

## Contracts we implement or consume, by file (at the pinned commits)

### Pi Durable (`packages/durable/`)
- `README.md`, `docs/spec.md`: the normative behaviour (single process per storage, replay rules, inbox, abort).
- `src/harness/types.ts`: `HarnessOptions` (`models`, `registry`, `env`, `settings`, `conversationCreated`), `ToolHooks.beforeTool` (async, may block), `Conversation`.
- `src/harness/tool.ts`: `ToolTask` – `beforeTool` runs in the `call` phase **before intent is recorded**; after intent, a restart reruns a tool only when it is `replay: "safe"`, else the model gets an `interrupted` result.
- `src/harness/events.ts`: `watchEvents()` / `AgentEvent` (`message_update` text/thinking deltas, `tool_execution_*`, `run_start`/`run_end`, `snapshot`).
- `src/storage/sqlite/node.ts`: `openNodeSqliteStorage()` on `node:sqlite` (WAL, `synchronous=NORMAL`).
- `src/tools/`: `read`, `write`, `edit`, `bash` and `CodingTools`.
- `test/examples/22-subagent-foreground.ts`, `23-subagent-background.ts`: the delegation pattern we follow.

### Pi AI / coding agent / env
- `packages/ai/README.md` §Auth, §Custom Providers, §OpenAI Compatibility: credential store contract, `createProvider`, `compat` flags.
- `packages/coding-agent/src/core/model-runtime.ts`: `ModelRuntime.create({ authPath, modelsPath })` implements pi-ai `Models`.
- `packages/coding-agent/src/core/auth-storage.ts`: `auth.json` with `proper-lockfile`; safe to share with a running Pi CLI.
- `packages/coding-agent/src/core/skills.ts`: `loadSkillsFromDir`, `formatSkillsForPrompt` (Agent Skills spec).
- `packages/env/README.md`: `connectSsh` / `sshConnection`, host-key pinning (`scanHostKey`, `acceptHostKey`), daemon deployment.

### Hermes (reference server)
- `apps/shared/src/gateway-contract.generated.ts` and `gateway-contract.openrpc.json`: generated wire contract (every RPC `Params`/`Result`, server requests, event payloads). This is the authority for payload shapes.
- `tui_gateway/ws.py`: `gateway.ready` first frame, newline-delimited JSON-RPC, token coalescing.
- `tui_gateway/server.py` (`_event_frame`, `write_json`): event envelope `{"method":"event","params":{"type","session_id","payload"}}`.
- `tui_gateway/server_requests.py`: server→client requests (`approval`, ...), `request.cancel`, `open_requests` replay on resume.
- `hermes_cli/web_routers/{status,profiles,sessions,models,skills,cron,chat_ws}.py`: REST shapes.

### Vory (primary client)
- `Packages/VoryCore/Sources/VoryCore/Networking/{GatewaySocket,HermesAPI,RequestSigner,ConnectionTester,JSONRPC}.swift`: transport, auth headers, 4401 handling, heartbeat (`ping` every 15 s).
- `Packages/VoryCore/Sources/VoryCore/Models/WireTypes.swift`: the fields Vory decodes (snake_case → camelCase).
- `Packages/VoryCore/Sources/VoryCore/Runtime/GatewayRuntime.swift`, `Chat/ChatSession.swift`: method usage, event handling, approval cards, resume snapshot (`running`, `inflight`, `open_requests`).
- `VoryTests/GatewayIntegrationTests.swift`: E2E suite we run against our gateway (`HERMES_E2E_URL`, `HERMES_E2E_TOKEN`).
- `Tools/mock-gateway/mock_gateway.py`: Vory's own mock; a compact description of what the app expects.

## Intentional deviations from Hermes
Recorded in `docs/COMPATIBILITY.md` (column "Notes"). The main ones:
- The runtime session id **equals** the stored session id (Hermes uses two). Vory accepts this (`stored_session_id ?? session_id`), and it makes multi-device fan-out trivial.
- Auth is the session-token mode only (`X-Hermes-Session-Token`, `?token=`), over Tailscale or TLS. The OAuth/password native flow is not implemented and `/api/status` reports `auth_required: false`.
