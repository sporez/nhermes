# Secrets in the panel, and Jev permission review (plan)

Status: in progress (decisions recorded at the end).

## Goal

1. Manage each gateway's environment variables (API keys, tokens) from the web panel and the CLI,
   without editing `secrets.env` by hand and without the panel ever showing a value.
2. Use those keys for the first feature that needs a new one: a Jev permission reviewer in the
   approval guard, adapted from the owner's OpenChamber plugin
   (`~/.config/opencode/local-plugins/opencode-auto-permissions-jev`, MIT, from hueyexe's
   opencode-auto-permissions). It lets the guard ask about many more commands while sending only the
   ones that do not fit the owner's request to an approval card.

## Where we start

- Secrets live in `secrets.env` next to `config.yaml`, loaded at startup (`loadEnvFile`,
  `src/config.ts`): each value is registered for log redaction and its name is kept out of bot shells
  (`secretEnvNames`, `scrubbedShellEnv`). Values do not override variables already set in the
  environment.
- Readers: `NHERMES_TOKEN` (startup), `PUSHOVER_*` (startup), provider keys referenced from Pi's
  `models.json` as `$NAME` (read when Pi resolves the provider), a bot's `secrets:` list for
  `http_request` (`{{secret:NAME}}`, at call time), a configured peer's `tokenEnv` (at call time).
- `GET /api/env` lists a fixed set of names for Vory with redacted values; nothing can change them.
- The approval guard (`src/core/policy.ts`, `guardExtension`) asks for about 20 high-impact command
  patterns and lets everything else run. Tonight's two incidents (ops reading `app.sqlite`, a disk
  check that froze the Mac) were commands outside that list.
- Neither gateway has an `OPENROUTER_API_KEY`; OpenChamber keeps its own OpenRouter connection, which
  the gateways cannot read.

## Steps

- [ ] S1. Secrets service and CLI
- [ ] S2. Secrets screen in the panel
- [ ] S3. Optional: set a key on other members too
- [ ] S4. Jev permission review in the guard
- [ ] S5. Wider ask list, reviewed by Jev
- [ ] S6. Review log in the panel

### S1. Secrets service and CLI

- `src/core/secrets.ts`: list names (never values), set, replace and remove a variable in
  `secrets.env`. Writes keep comments and order, go through a temp file and a rename, and keep mode
  `0600`.
- A set applies at once: `process.env`, log redaction, and the bot-shell exclusion list. A removal
  unsets it. Variables read only at startup (`NHERMES_TOKEN`, `PUSHOVER_*`) report "takes effect
  after a restart", like config edits do.
- A catalogue of known names, each with a description and where it is used: the built-ins above,
  `$NAME` references found in `models.json`, every bot's `secrets:` list, every peer `tokenEnv`, and
  `OPENROUTER_API_KEY` (S4). Unknown names in the file are listed as "not used by anything".
- Each entry shows: set or not, set in `secrets.env` or by the process environment (then read-only
  here), last changed, and the last four characters only when the owner asks to identify a key.
- `NHERMES_TOKEN` gets a "generate a new token" action: the new value is shown once, with a warning
  that Vory and the CLI need it.
- CLI: `nhermes secret list`, `nhermes secret set NAME` (reads the value without echoing it),
  `nhermes secret rm NAME`. Admin API under `/admin/secrets`.
- Backups keep excluding `secrets.env` unless `--secrets`.
- Tests: set/replace/remove keep comments and mode; live effect on redaction and shell scrubbing;
  restart-only names reported; values never appear in any response.

### S2. Secrets screen in the panel

- New "Keys" tab: the catalogue with status and where each key is used; Set, Replace, Remove, and
  "Generate new token". Values are write-only: inputs are password fields, and no endpoint returns a
  value (the identify action returns the last four characters).
- A bot's editor links to the keys its `secrets:` list names; the Gateway screen links to the review
  key (S4).
- `/api/env` for Vory reads the same catalogue (still read-only and redacted).
- Access: decision for the owner (open question 1).

### S3. Optional: set a key on other members too

- "Also set on" picks members; the value goes over the member link to their `/federation/secrets`.
- Off by default on the receiving side: a gateway accepts keys from members only when its owner turns
  on "accept keys from network members" (per gateway). Every received key is logged with the sender.
- Values travel as plain HTTP on the LAN (encrypted only over Tailscale), the same as everything else
  between members; the panel says so.

### S4. Jev permission review in the guard

- When the guard would ask, it first asks Jev (`~typesafe/jev-latest` through OpenRouter's
  `/api/alpha/decisions`, key `OPENROUTER_API_KEY`) to choose allow or deny, with:
  - the owner's recent messages from the chat where the work started (human authorization);
  - the delegation chain's task texts, marked as delegated, not human authorization;
  - the bot, its machine, and the exact tool call.
- A confident allow (default ≥ 0.8) runs without a card. Deny, low confidence, an error, no key, or
  no answer within 3 s gives the normal card, with Jev's recommendation in its description.
- Never sent to Jev (always a card): deny rules; the destructive group (`rm -rf /` or `~`, `mkfs`,
  disk wipes and checks, power, credentials, firewall flush, fork bomb); writes to sensitive paths;
  work started by another machine (its human is not here; the card goes back to the caller's chat as
  today); scheduled jobs set to "ask".
- The reviewer's instructions start from the plugin's decision rules and add this gateway's: never
  approve reading or using the gateway's own config, secrets or databases; never approve reaching
  other machines or bots outside `delegate`; heavy maintenance only when the human asked for that
  specific thing.
- Known secret values are redacted from everything sent. Commands leave the machine for OpenRouter
  and TypeSafe; the Gateway screen says so where the review is turned on.
- Config: `review: { jev: { enabled, keyEnv, allowThreshold, timeoutMs, shadow } }`. Shadow mode
  logs what Jev would have done and changes nothing, for a trial period.
- Tests with a fake decisions endpoint: approve skips the card; deny, low confidence, timeout, error
  and missing key give the card; the never-reviewed groups never call it; nothing secret is sent.
  Then a live check of tonight's two incidents and a set of everyday commands.

### S5. Wider ask list, reviewed by Jev

- With Jev in front, asking about more costs little. Add patterns modelled on the owner's OpenCode
  config: `rm`, `chmod`/`chown`, `git` writes, `ssh`/`scp`/`rsync`, `bash -c`/`sh -c`, inline scripts
  (`python3 -`, `python3 -c`, `node -e`, heredocs into an interpreter), `curl`/`wget` to `| sh`,
  `docker`/`kubectl`/`terraform` changes, publish commands; plus anything naming the gateway's own
  folders, `secrets.env`, `app.sqlite`, `durable.sqlite`, `auth.json`.
- Without a review key these stay as they are today (the list grows only with review on), so a
  gateway without Jev does not start nagging.

### S6. Review log in the panel

- Each review is recorded (audit table): bot, chat, command, Jev's probabilities, outcome, time.
- Status screen: recent reviews, with the ones that became cards first; a filter for "auto-approved".

## Security notes

- The panel never returns a secret value. With no panel password, anyone on the LAN can still set or
  replace keys (open question 1).
- A bot's shell runs as the gateway's user and can read `secrets.env` directly. S1 does not change
  that; the ground rules, the guard (S5 asks for anything naming the file) and, for a hard boundary,
  a separate OS user for the gateway do.
- Jev is a reviewer, not a sandbox: it judges the command text it is shown.

## Decisions (owner, 2026-10-15)

1. The Keys tab follows the panel's own access setting; no extra password.
2. S3 is wanted: setting a key on other machines from one panel.
3. Jev review goes live at once (no shadow period). Its decisions must be visible in the panel (S6).
