# Status (2026-10-15)

"Automated" = our suite (`npm test`, 90 tests, faux model, no network). "Live" = exercised against a real
model (now `neuralwatt/deepseek-v4.1-flash`; earlier runs used `cerebras/gpt-oss-120b`, both via Pi's provider layer) and/or the stock Vory client.

Deployment under test: the **hermes VM** (Debian 13, on the LAN), nHermes as a systemd user service on
port 9120 next to the existing Hermes (9119, untouched). Bots: `main`, `ops` (trusted, SSH host),
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
chat picked its own in Vory.

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
