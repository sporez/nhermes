# Provider logins from the panel, on any machine (plan)

Status: accepted, in progress.

## Goal

Log a gateway into a model provider (xAI/Grok, OpenAI Codex, ChatGPT, GitHub Copilot, Kimi, Anthropic,
…) from the web panel, without the `pi` CLI and without SSH. Do the same for **any member of the
network from one panel**: open the Logins tab, pick a machine and a provider, approve the code on your
phone, done. The login is made on the machine that will use it, and its credentials never leave that
machine.

## Where we start

- Each gateway owns its credential store. `loadModels` (`src/app.ts`) creates Pi's `ModelRuntime` over
  `pi.authPath` (default `~/.pi/agent/auth.json`) and `pi.modelsPath`. Nothing else opens those files.
- Pi already has the login flows. `Models.login(providerId, "oauth", interaction)` runs the provider's own
  flow and persists the credential under the store lock. `ModelRuntime.login` also refreshes its provider
  state. `Models.logout` removes a credential. `getProviders()` lists providers, and
  `provider.auth.oauth` has a `loginLabel` (for example "Sign in with SuperGrok or X Premium") and
  `isSubscription`. Read in `reference/pi/packages/ai/src/models.ts` and
  `coding-agent/src/core/model-runtime.ts`.
- A flow talks to its user through two callbacks (`AuthInteraction`, `ai/src/auth/types.ts`):
  - `notify(event)`, where the event is one of:
    - `device_code { userCode, verificationUri, expiresInSeconds }`
    - `auth_url { url, instructions }`
    - `info { message, links }`
    - `progress { message }`
  - `prompt(p)`, which returns a string, where `p` is one of `text`, `secret`, `select { options }` or
    `manual_code`.
  - Nothing in this is terminal-specific, so a web page can drive it.
- The flows are of two kinds:
  - Device-code flows (`xai`, `github-copilot`, `kimi-coding`, `meta`, `openai-chatgpt`, `openai-codex`
    and `radius` mention device codes) work from anywhere: the machine shows a code and a link, you approve
    on any device.
  - Callback flows (`anthropic`, `openai-codex`, `openrouter`, `radius`) start a callback server on the
    gateway's own `127.0.0.1`, and race it against a `manual_code` prompt (`callback-server.ts`). A
    browser on another device can't reach that callback, but pasting the redirected address into the
    prompt completes the login.
- Today a new login means running `pi` on the machine, in a shell where it is on PATH, with the same
  `auth.json` path. The only way to reuse a login elsewhere is copying `auth.json`. Two machines then
  share one refresh token, and a provider that rotates refresh tokens breaks whichever refreshes second.
- Precedents to follow:
  - Keys: the Keys tab, write-only values, "Send to…" over the member link, and `acceptSecrets` off by
    default (`docs/SECRETS-AND-REVIEW.md`).
  - Remote bot edits: `/panel/api/remote/<node>/…` forwarded to `/federation/manage/…`, and
    `acceptBotEdits` off by default (`docs/REMOTE-BOT-EDITS.md`).
- `src/panel/static/panel.js` is 1,098 lines, so it gets a responsibility extracted before new screens go
  in (AGENTS.md).

## Decisions

1. **The machine that uses a login makes it.** A login always runs inside the gateway process that owns
   the store, through `ModelRuntime.login`, never by writing `auth.json` directly. Only the flow's prompts
   and events cross the network (device codes, links, messages). Tokens never cross, so each machine gets
   its own refresh token.
2. **A login is a short-lived session in `core/`** (`src/core/logins.ts`). Each one has:
   - id, provider, state (`waiting` · `prompt` · `done` · `failed` · `cancelled`) and the events so far
   - the pending prompt, if any: type, message and options, without any answer
   - the started and finished times, and the outcome message

   The panel, the CLI and members are clients of it. It is kept in memory only: a restart cancels open
   logins.
   - Limits: one open login per provider per machine, a few at a time per machine, and a timeout (the
     device code's expiry, or 10 minutes). It is cancellable.
3. **The panel polls.** It uses `GET …/logins/:id` about once a second while a login is open, and answers
   with `POST …/logins/:id/answer`. No new socket type. That works the same through the member proxy.
4. **Remote logins are opt-in per machine, off by default.** The switch is "Let other machines log this
   machine in to model providers", in Network, beside the keys and bot-edit switches. It is its own switch,
   not "edit bots", because it touches credentials (owner, 2026-10-20). Calls go to `/federation/logins/…` over TLS-PSK only, are refused on a replaced pair key
   (`KEY_CHANGING_PATHS`), and are logged with the member's name.
5. **Callback flows on a remote machine:** the panel shows the provider's link. When the browser lands on a
   page that can't load (`127.0.0.1:<port>/…`), the page asks you to copy that page's address and paste it.
   Pi's `manual_code` prompt takes it. The step is said plainly in the page; nothing is guessed.
6. **The Logins tab shows status without touching the network.** Per machine and provider it shows:
   - logged in (OAuth, with expiry), set by a key (secrets.env / the service environment, a link to Keys),
     or not set
   - the last refresh failure, if one was seen ("needs signing in again")

   Status reads the stored credential and the runtime's auth source labels. It never triggers a token
   refresh just to draw the page.
7. **API keys stay in Keys.** Pi's api-key logins would put keys into `auth.json`, beside the
   `secrets.env` keys the gateway already manages. To keep one store for keys, a provider that takes only
   a key links to the Keys tab. OAuth is what Logins adds.
8. **CLI for headless use:** `nhermes auth list`, `nhermes auth login <provider> [--machine <member>]` and
   `nhermes auth logout <provider> [--machine <member>]`, through the admin API like every CLI command.
   The terminal prints the code and link, and reads prompts (secrets without echo, `readHidden`).
9. **After a login or logout the models follow.** The provider's models appear in or leave the model
   pickers at once (the panel, and Vory's existing model lists, unchanged), as setting a catalog key does today. A bot whose model needs that login
   says so in the panel.
10. **No bot tool.** Bots never start, answer or cancel a login (no `self_*` or `gateway_*` tool). The
    panel guard against bots reaching their own panel already covers the HTTP routes.

## Phases

Each phase lands as tested commits and updates `docs/STATUS.md`, `docs/OPERATIONS.md` and
`ARCHITECTURE.md` where they change.

### L0. Room in the panel script

- Split `src/panel/static/panel.js` along a real seam before adding a screen. The likely split is the
  shared helpers (`h`, `api`, toasts, the in-page confirm) away from the screens, or the screens into
  their own files. Plain `<script type="module">` files: no build step, and they work in Safari and
  embedded browsers. No visible change.
- Check: `node scripts/panel-dev.ts`, every tab in light and dark, and the panel tests.

### L1. Login sessions and the CLI (this machine)

- `src/core/logins.ts` holds the session state machine (decision 2) over `core.models`:
  - `list()` gives providers with login methods and status (decision 6).
  - `start(provider)` gives a session.
  - `answer(id, value)`, `cancel(id)`, `get(id)` and `logout(provider)`.
- Admin API under `/admin/logins` (token). CLI `nhermes auth list | login | logout`.
- Redaction:
  - A `secret` prompt's answer is registered with the scrubber and never stored in the session.
  - Pi error messages are redacted before they reach a session, a log line or a response.
- Tests use a fake `Models`, injected through `CoreOptions.models`, whose `login` emits a device code,
  asks a `secret` prompt and a `manual_code` prompt, and then succeeds, fails, is cancelled or times out.
  They check:
  - the states and the one-per-provider rule
  - the timeout and cancel paths
  - that the secret answer never appears in `get()`, logs or events
  - that logout calls through
  - that a restart drops open sessions

### L2. Logins in the panel (this machine)

- A **Logins** tab of its own (owner, 2026-10-20):
  - providers with status
  - "Log in" opens an in-page step view: the device code, large and copyable, with its link and a
    countdown; links for `auth_url`; prompt fields (secret as a password field, `select` as buttons,
    `manual_code` with the paste instructions from decision 5); progress lines
  - "Cancel", and "Log out" behind the in-page confirm
- Panel routes `/panel/api/logins…` call `core/logins.ts`. Writes follow the panel write guard as usual.
- Tests: panel API cases in `test/panel/panel.test.ts`. A panel-dev pass in light and dark with the
  fake provider wired into `scripts/panel-dev.ts`.

### L3. Remote logins (any machine from one panel)

- `/federation/logins…` on the owning machine, refused unless its switch is on (decision 4), TLS-PSK only.
  Also refused on a replaced key.
- `/panel/api/remote/<node>/logins…` forwards to it, as remote bot edits do. The Logins tab lists
  every member (an offline mark for unreachable ones), with the same step view; prompts and answers
  travel over the member link.
- The Network screen gets the new switch.
- `nhermes auth … --machine <member>`.
- Tests:
  - two in-process gateways with fake `Models`
  - a login on B started and answered from A's panel, with the credential saved only by B's `Models` and
    no token in any A response or log
  - a refusal with the switch off
  - a refusal on a previous-key connection
  - B going offline mid-login, which fails cleanly on A

### L4. Status and failures

- Remember the last OAuth refresh failure per provider (Pi rejects with `ModelsError` code `oauth`).
  Show it in Logins, and notify the owner once ("Grok on media needs signing in again"), through the
  usual notifier (members forward when they have no transport).
- Mark bots whose model's provider has no working login (panel Bots list).
- Tests for the failure record, the single notification and the bot mark.

### Acceptance

- Live, by hand:
  - From one gateway's panel, sign media into xAI with the device code on a phone, and run one Grok turn
    on media.
  - Repeat the same steps for a callback provider (paste step) on another member.
  - Log out from the panel; the models leave the pickers.

## Security notes

- Credentials (access and refresh tokens, API keys) are never returned by any endpoint, never sent to
  another machine, and never written anywhere but the owning machine's Pi credential store.
- A `secret` prompt's answer is write-only: registered for redaction, never kept in the session, and never
  in events.
- Device codes and auth links do cross the panel's plain HTTP on the LAN, like everything else the panel
  shows. Someone who saw a user code in that window could approve it with *their* account and sign the
  machine into it. The window is short and logging out undoes it. L1 checks whether Pi's flows report
  the signed-in account; if they do, the step view shows it. This is the same trust the panel has today;
  put the panel behind TLS for more.
- Remote logins are opt-in per machine, TLS-PSK only, refused on a replaced pair key, and logged with the
  member's name. A member can start a login on a machine, but it cannot read that machine's credentials.
- Bots have no way in: no tool, and the panel is blocked to bots' own tools (`src/tools/own-gateway.ts`).
- Limits per machine (decision 2) keep a member or a stray page from opening many flows.

## Decided (owner, 2026-10-20)

1. Remote logins get their own switch, separate from "Let other machines edit this machine's bots".
2. Logins get a tab of their own in the panel.
3. Vory is left alone: the owner runs stock Vory, and nothing here changes what Vory sees or calls.

## Progress

- [ ] L0 room in the panel script
- [ ] L1 login sessions and CLI
- [ ] L2 panel (this machine)
- [ ] L3 remote logins
- [ ] L4 status and failures
