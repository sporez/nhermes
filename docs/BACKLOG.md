# Backlog

Phases follow the brief. Each item lands as a tested commit; `docs/COMPATIBILITY.md` and `docs/STATUS.md`
are updated with it.

## Findings that shaped the plan (Phase 0)

- Pi Durable 1.2.0 already provides: durable conversations and runs, idempotent submissions
  (`requestId`), tool tasks with replay rules, async `beforeTool` hooks that run before intent (so an
  approval wait survives a restart without the tool running), inbox follow-up/steer, abort, compaction,
  per-conversation agent config (model, thinking, extensions, tools, instructions, cwd), task-owned child
  conversations (delegation), `watchEvents` for live streaming, SQLite storage on `node:sqlite`.
- It does not provide: bots/identities, session catalogue and titles, approvals UI/protocol, memory,
  scheduling, notifications, a network API. These are ours.
- Pi's `ModelRuntime` (coding-agent package) reads the same `auth.json`/`models.json` as the Pi CLI,
  including OAuth subscriptions (openai-codex, xai) and custom OpenAI-compatible providers (Neuralwatt,
  Synthetic, omlx); verified live on 2026-10-14. Shared use with a running Pi CLI is safe (file lock).
- `pi-env` provides SSH remote execution (Mode A) with host-key pinning and a self-deploying daemon.
- Vory's own E2E suite runs against any gateway URL + session token: it is our acceptance test.
- Vory needs `/api/config`, `/api/config/schema` (`approvals.mode`), `/api/tools/toolsets`, `/api/env`
  to be non-empty for its REST E2E test; we serve real values for those.

## Needs from the owner (remaining)

1. A second VM for `ops` to administer over SSH (currently loopback on the hermes VM).
2. Pushover user key and app token.
3. Optional: a dashboard token for the existing Hermes to capture real fixtures.

## Phases

Status per phase: see `docs/STATUS.md`.

- [x] **1. Vory connection**: config, app DB, engine boundary, bots, sessions, events, Hermes REST + WS,
  approvals, CLI `serve`/`token`, Vory E2E suite green against a real model, restart recovery.
- [x] **2. Agents and remote execution**: second bot with its own model/skills/memory, SSH host (pi-env),
  `delegate` tool (local), peer agent mode + registration.
- [x] **3. Skills and memory**: SKILL.md loading per bot and per job, `skill` tool, memory tools + FTS5,
  shared spaces, pinned memory in the prompt.
- [x] **4. Scheduling and notifications**: scheduler, job sessions, run history, missed/overlap rules,
  Pushover, Hermes cron endpoints, `schedule_*` tools.
- [x] **5. Computer use**: Playwright browser tools + E2E; Linux desktop tools over SSH + E2E.
- [x] **6. Reliability and polish**: backup/restore, systemd/Podman, upgrade/migrations, Vory UI pass,
  security review, docs.
- [ ] **7. Federation and control panel**: private bots, runtime config, membership (invite/join),
  roster sync, remote bots as Vory profiles, web control panel at `/panel`. Plan: `docs/FEDERATION.md`.
- [x] **8. Secrets in the panel and Jev permission review**: write-only key management (panel, CLI),
  optional copy to members, Jev review in the approval guard with a wider ask list. Plan:
  `docs/SECRETS-AND-REVIEW.md`.
