# Computer use

## Browser (`browser` tool group)

Playwright drives Chrome/Chromium. Each bot has its own persistent profile in `data/browser/<bot>/profile`
(cookies and logins persist; profiles are never shared between bots), started on first use, closed after
10 idle minutes. Set `browserExecutable: /usr/bin/google-chrome` to use an installed Chrome, otherwise
Playwright's own build (`npx playwright-core install --with-deps chromium`). A bot can attach to a browser
elsewhere instead with `browser: { cdpUrl: http://host:9222 }`.

The model reads pages through Playwright's AI accessibility snapshot (`[ref=e12]` element refs) and acts
with `browser_click/type/select/press/scroll/back/wait`; each action returns the new snapshot.
`browser_tabs` lists and switches tabs (links that open a new tab switch to it). `browser_screenshot`
returns an image to vision-capable models and saves it under `data/browser/<bot>/shots` (not sent
anywhere else). Operations of one bot are serialized; two chats of one bot share its tabs.

Verified: `test/computer/browser.test.ts` (search form → results → new tab → JS button → screenshot →
tabs → cookie persists across a browser restart), and live with a real model on Wikipedia.

## Desktop (`desktop` tool group)

Runs through the bot's execution environment, so it controls the X11 desktop of the gateway host or of
the bot's SSH host. The gateway itself needs no graphical session.

Prerequisites on the desktop machine: an X11 session (`DISPLAY`, default `:0`, set per bot with
`desktop: { display: ":0" }`), readable `~/.Xauthority` for the user the tools run as, and
`xdotool imagemagick wmctrl python3-pyatspi at-spi2-core`.

| Tool | Uses |
|---|---|
| `desktop_screenshot` | ImageMagick `import -window root` (returned as an image, screen pixels) |
| `desktop_click`, `desktop_scroll` | `xdotool mousemove/click` |
| `desktop_type`, `desktop_key` | `xdotool type/key` |
| `desktop_windows`, `desktop_focus` | `wmctrl` |
| `desktop_launch` | starts an installed program detached (reports when it is not installed) |
| `desktop_accessibility` | AT-SPI tree with roles, names, positions and text of text widgets |

Limits: X11 only (Wayland sessions are not supported by xdotool); apps that do not expose AT-SPI
(some Electron/Java apps) only show in screenshots; coordinates assume no screen scaling. To watch or
take over, use any VNC server on that display (e.g. `x11vnc -display :0 -localhost` through SSH); no
custom streaming protocol is involved.

Verified live on the hermes VM (Debian 13, XFCE, `:0`): open Mousepad, type text, confirm it through
the accessibility tree (5 model calls with `cerebras/gpt-oss-120b`).

## Spaces (`spaces` tool group)

A bot with the `spaces` group opens a disposable Linux desktop on the gateway host (a space, run by Cua; setup,
isolation and limits in `docs/SPACES.md`), uses it and throws it away.

| Tool | Does |
|---|---|
| `space_open` | opens a space (a few seconds) and returns its id |
| `space_list`, `space_close` | the bot's open spaces; delete one |
| `space_shell {space, command, timeout?}` | runs a shell line in the space as the user `cua`; output is cut to the last 20,000 characters, the exit code is shown |
| `space_copy {space, from, to, direction}` | copies one file (up to 100 MB) between the space and the bot's own machine, `to_space` or `from_space` |
| `space_view {space, caption?}` | gives the owner a card to watch the space live and take control of it; the bot carries on |

Every desktop tool takes an optional `space`. With it the tool acts inside that space, on its desktop (display
`:1`) instead of the bot's own. The `spaces` group includes the desktop tools, so a bot with only `spaces`
can drive its spaces; without a `space` argument such a bot (any bot without the `desktop` group) is refused,
and never reaches the gateway host's own desktop. A screenshot taken in a space offers itself to `show` like any
other, so the owner can be shown a picture of it, and `space_view` lets the owner watch it live, through the
gateway the app is connected to, wherever the bot runs (`docs/API.md` "Watching a space"; the panel's Status tab
has Watch and Take control too). A space is deleted when the bot closes it, after `spaces.idleMinutes` unused
(never while a call is using it or the owner is watching it), or when the gateway stops. Each bot has its own
spaces; the limits are `spaces.perBot` and `spaces.total`.

## Safety

Desktop and browser actions are ordinary tool calls: they show in the nHermes app as tool calls (turn items, `docs/API.md`), can be stopped
with Stop, and pass the approval policy. `approvals: manual` on a bot asks before every click/type.
Content read from pages and screens is untrusted: it never changes policy.
