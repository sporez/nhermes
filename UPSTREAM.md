# Upstream pins

Reference clones live in `reference/` (git-ignored, read-only). Re-create them with
`scripts/fetch-upstream.sh`, which checks out exactly these commits.

| Project | Repository | Pinned commit | Commit date | Recorded | License |
|---|---|---|---|---|---|
| Pi (incl. Pi Durable) | https://github.com/earendil-works/pi | `06a466935536f8c9bcacb2d5efc0fc021be1bdff` (tag `v1.2.0`) | 2026-10-13 | 2026-10-14 | MIT (Mario Zechner) |
| Hermes Agent (credit for ported code; not cloned) | https://github.com/NousResearch/hermes-agent | `300228d24c593f779055204753921fbe9a2163c5` | 2026-10-14 | 2026-10-14 | MIT (Nous Research) |

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
| `@earendil-works/pi-mcp` | 1.2.0 | MCP client (`McpClient`, `StreamableHttpTransport`, `toLlmContent`) for MCP servers (`src/mcp/`) |

All six come from the same Pi release and must be upgraded together. `test/upstream/` holds the
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

### Pi MCP (`packages/mcp/`)
- `README.md` §Supported protocol surface: MCP `2025-11-25` with an `initialize` handshake (accepting 2025-06-18, 2025-03-26, 2024-11-05). Not the stateless `2026-07-28`; a server that speaks only that revision rejects this client.
- `src/client.ts`: `McpClient` (request timeouts renewed by progress, `notifications/cancelled` on timeout or abort, `connectionState` stays `connected` after a failed request).
- `src/transports/streamable-http.ts`: a failed POST rejects only that request and never resends it; 401 → `McpAuthRequiredError`, 404 with a session → `McpSessionExpiredError`, other statuses → `McpHttpError`; a broken response stream becomes JSON-RPC `-32603` "MCP response stream failed: …".
- `test/upstream/mcp-contract.test.ts` pins these shapes, Durable re-installing an extension at runtime (`tool_unavailable` for a removed tool), and pi-ai validating plain JSON Schema arguments.

### Pi AI / coding agent / env
- `packages/ai/README.md` §Auth, §Custom Providers, §OpenAI Compatibility: credential store contract, `createProvider`, `compat` flags.
- `packages/coding-agent/src/core/model-runtime.ts`: `ModelRuntime.create({ authPath, modelsPath })` implements pi-ai `Models`.
- `packages/coding-agent/src/core/auth-storage.ts`: `auth.json` with `proper-lockfile`; safe to share with a running Pi CLI.
- `packages/coding-agent/src/core/skills.ts`: `loadSkillsFromDir`, `formatSkillsForPrompt` (Agent Skills spec).
- `packages/env/README.md`: `connectSsh` / `sshConnection`, host-key pinning (`scanHostKey`, `acceptHostKey`), daemon deployment.

### Hermes Agent (ported logic, MIT)
nHermes once spoke the Hermes gateway protocol so the Vory app could drive it; that layer is gone, and so
is Vory's push relay (`docs/CLIENT-API.md`). What remains from Hermes is ported code, credited where it
lives:
- `gateway/hosted_room_discussion.py` `plan_next_task` → `src/core/room-plan.ts` (group chat turn planning).
- `agent/context_references.py` (`@file:` expansion, `format_reference_value`, the on-disk note) and
  `tui_gateway/prompt_attachments.py` (attachment lines) → `src/core/attachments.ts`.
