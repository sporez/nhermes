# Status (2026-10-16)

"Automated" = our suite (`npm test`, 90 tests, faux model, no network). "Live" = exercised against a real
model (now `neuralwatt/deepseek-v4.1-flash`; earlier runs used `cerebras/gpt-oss-120b`, both via Pi's provider layer) and/or the stock Vory client.

Deployment under test: three gateways in one network, all on port 9119 with the encrypted member port
10119: the **hermes VM** and **media VM** (Debian 13, systemd user services) and the **Mac** (launchd).
The original Hermes was removed from the hermes VM and the Mac on 2026-10-16. On the hermes VM: Bots: `main`, `ops` (trusted, SSH host),
`desktop` (XFCE on `:0`), `mac` (peer agent on Neil's Mac; since replaced by the network of gateways, `docs/FEDERATION.md`).

| # | Definition of done | Automated | Live | Notes |
|---|---|---|---|---|
| 1 | Gateway on Debian | – | ✅ systemd user service on the hermes VM | `docs/OPERATIONS.md` |
| 2 | Stock Vory connects | protocol tests | ✅ Vory `GatewayIntegrationTests` pass against the Mac and the VM gateway; Vory UI E2E (onboarding → chat → settings) passes | 2 Vory tests are mock-only (see COMPATIBILITY) |
| 3 | Chat with a named agent on a configured model | ✅ | ✅ | |
| 4 | Tool activity + genuine approvals | ✅ | ✅ real model asked to install a package: approval request over Hermes protocol; deny blocked it, once ran it | Approval card in the Vory UI itself not yet driven live |
| 5 | Disconnect, restart, recover | ✅ mid-answer, pending approval, job mid-run | ✅ sessions survive service restarts | |
| 6 | Second agent, own identity/model/skills/memory | ✅ | ✅ `ops`, `desktop` | |
| 7 | Remote VM administration | ✅ (pi-env daemon) | ✅ `ops` runs on the hermes VM itself (no `host:`) and reaches `pm` and `proxy` with its own SSH key, following the `homelab-vms` skill | Bot `host.ssh` stays available for a bot that should live on another machine |
| 8 | Delegation and result | ✅ foreground, background, approvals routed to root chat, no privilege escalation | ✅ main → ops, main → mac (peer) | |
| 9 | SKILL.md skill | ✅ | ✅ `disk-report` loaded and followed | |
| 10 | Memory across sessions, search, sharing | ✅ incl. boundaries | ✅ remember in one chat, recall in another | |
| 11 | Recurring task from agent/Vory, unattended, history | ✅ | ✅ created from chat, Run now from the cron API, history | |
| 12 | Notifications | ✅ Pushover (recording transport); Vory push relay incl. member bots (`test/hermes/vory-push.test.ts`, `test/federation/vory-push.test.ts`) | Pushover ❌ skipped by owner (no keys) | `PushoverNotifier` untested against the real API; Vory push (`src/notify/vory.ts`) is the main channel |
| 13 | Browser workflow | ✅ local site, multi-tab, refs, persistence | ✅ Wikipedia search → article → infobox → screenshot | |
| 14 | Remote desktop interaction | – | ✅ hermes VM XFCE: open Mousepad, type, verify via AT-SPI | The editor restored an unsaved draft from an earlier run, so the document was not empty |
| 15 | Independent VM-resident agent | ✅ two gateways, relayed approval, dropped connection | ✅ peer on the Mac, registered with the VM gateway, answered a delegated task | The peer runs on a Mac, not a VM |
| 16 | Backup and restore | ✅ | ✅ on the VM: backup while running, restore refused while running, restore + restart | |
| 17 | OpenChamber threads (`openchamber` tool group, event watcher) | ✅ fake server: read and control tools, policy, event watcher (permission, form, finish, child skip, debounce, reconnect) | Live, 2026-10-18, tools run locally against OpenChamber 2.4.0 / OpenCode 2.0.32: oc_sessions, oc_read, oc_waiting, oc_diff (whole thread and last turn) ✅; oc_start with OpenChamber's default model and variant ✅, the thread shows in OpenChamber ✅; oc_answer on a real question ✅; oc_prompt ✅; oc_stop interrupts a running tool ✅; the watcher reported the question and the finished thread from the live stream ✅; a permission card escalated past the Jev reviewer showed in oc_waiting with the reviewer's recommendation, and oc_approve rejected it, the thread saw the rejection ✅ | The watcher's permission notice is tested on the fake server only. Not yet run through a deployed gateway and Vory |

## Security findings fixed during live testing

- A denied package install was retried by delegating to the trusted `ops` bot → delegation now never
  raises privileges (`test/core/delegate.test.ts`).
- Untrusted bots could `sudo apt-get install` without asking → installs and `sudo` now ask.
- A remembered "always" answer for one pattern could cover another pattern in the same command → every
  matching pattern must be allowed on its own (`test/core/policy.test.ts`).

- Bots' shells inherited the gateway's environment, including provider keys and the gateway token →
  shells now get a scrubbed environment and known secret values are redacted from tool output, transcript
  rows and events (`test/core/web.test.ts`). Redaction of streamed text works per delta, so a secret split
  across two deltas would not be caught there (the stored transcript row is still redacted).

## Models

All bots default to `neuralwatt/deepseek-v4.1-flash`. The VM and the Mac agent each have their own
`models.json` listing Neuralwatt's full library (27 models), generated with `scripts/neuralwatt-models.ts`;
the key is read from `NEURALWATT_API_KEY` in `secrets.env`. Sessions follow their bot's model unless a
chat picked its own in Vory. Neuralwatt is now a catalog provider (`src/models/neuralwatt.ts`): the key
alone brings its live list. Those `models.json` files still win while they define `neuralwatt`; remove
that entry (or the file, and `pi.modelsPath` with it) to switch a machine to the automatic list.

## Open items

- Pick a second VM for `ops` (real remote host) and, if wanted, move the Mac peer to a VM.
- Pushover keys for a live notification test.
- Drive an approval card and the cron screens in the Vory UI by hand once.
- Vory's settings and maintenance screens (Tools, Config, Env, Files, Analytics, update/restart/doctor, logs)
  are implemented, also for members' bots (`docs/REMOTE-BOT-EDITS.md`); Projects, MCP servers and bot rooms
  still answer 404 / -32601. See `docs/COMPATIBILITY.md`.
- Federation F5: Vory's E2E suite and a UI pass with a remote profile selected are not run yet
  (`docs/FEDERATION.md`).
- Hermes on the VM still runs on 9119. Stopping it is a later step (owner allowed it if needed).
