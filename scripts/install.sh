#!/bin/sh
# Installs or upgrades nhermes for the current user on Linux or macOS, and runs it as a service.
#
#   curl -fsSL https://raw.githubusercontent.com/sporez/nhermes/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/sporez/nhermes/main/scripts/install.sh | sh -s -- --join nh1.…
#
# Options:
#   --join <code>    join a network after installing (code from `nhermes invite` on any member)
#   --name <name>    this machine's name in the network (default: the host name)
#   --port <port>    port for Vory, other machines and the panel (default: 9119)
#   --no-service     install only; do not set up or restart the service
#
# Nothing needs root. Running it again upgrades the code and restarts the service; config and data stay.
# Locations (override with the environment variables):
#   code   $NHERMES_DIR         (default ~/nhermes)
#   config $NHERMES_CONFIG_DIR  (default ~/.config/nhermes: config.yaml, secrets.env)
#   data   $NHERMES_DATA_DIR    (default ~/.local/share/nhermes)
set -eu

REPO=${NHERMES_REPO:-https://github.com/sporez/nhermes}
BRANCH=${NHERMES_BRANCH:-main}
NODE_VERSION=24.21.0
DIR=${NHERMES_DIR:-$HOME/nhermes}
CONF_DIR=${NHERMES_CONFIG_DIR:-$HOME/.config/nhermes}
DATA_DIR=${NHERMES_DATA_DIR:-$HOME/.local/share/nhermes}
JOIN=""
NAME=""
PORT=""
SERVICE=1

while [ $# -gt 0 ]; do
	case "$1" in
		--join) JOIN=$2; shift 2 ;;
		--name) NAME=$2; shift 2 ;;
		--port) PORT=$2; shift 2 ;;
		--no-service) SERVICE=0; shift ;;
		-h|--help) sed -n '2,19p' "$0" 2>/dev/null || true; exit 0 ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
	Linux) OS=linux ;;
	Darwin) OS=darwin ;;
	*) die "only Linux and macOS are supported" ;;
esac
case "$(uname -m)" in
	x86_64|amd64) ARCH=x64 ;;
	arm64|aarch64) ARCH=arm64 ;;
	*) die "unsupported CPU: $(uname -m)" ;;
esac

# --- Node 24 (user-local when the system has no Node 24) ---
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] 2>/dev/null; then
	NODE=$(command -v node)
fi
if [ -z "$NODE" ]; then
	NODE_HOME="$HOME/.local/node-v$NODE_VERSION-$OS-$ARCH"
	if [ ! -x "$NODE_HOME/bin/node" ]; then
		say "Installing Node $NODE_VERSION in $NODE_HOME"
		mkdir -p "$HOME/.local"
		curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$OS-$ARCH.tar.gz" | tar xz -C "$HOME/.local"
	fi
	NODE="$NODE_HOME/bin/node"
fi
NODE_BIN=$(dirname "$NODE")
export PATH="$NODE_BIN:$PATH"
say "Using Node $("$NODE" -v) ($NODE)"

# --- Code ---
if [ -d "$DIR/.git" ]; then
	say "Updating $DIR"
	git -C "$DIR" fetch --quiet origin "$BRANCH"
	git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH" || die "$DIR has local changes; update it by hand"
else
	if [ -e "$DIR" ]; then
		OLD="$DIR.old-$(date +%Y%m%d-%H%M%S)"
		say "Moving the existing $DIR (not a git checkout) to $OLD"
		mv "$DIR" "$OLD"
	fi
	say "Downloading nhermes into $DIR"
	if command -v git >/dev/null 2>&1; then
		git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
	else
		mkdir -p "$DIR"
		curl -fsSL "$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar xz -C "$DIR" --strip-components 1
	fi
fi
(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# --- Config (only the first time) ---
NH="$DIR/bin/nhermes"
export NHERMES_CONFIG="$CONF_DIR/config.yaml"
FIRST=0
if [ ! -f "$NHERMES_CONFIG" ]; then
	FIRST=1
	say "Writing a starter config in $CONF_DIR"
	set -- init "$CONF_DIR" --data-dir "$DATA_DIR"
	[ -n "$NAME" ] && set -- "$@" --name "$NAME"
	[ -n "$PORT" ] && set -- "$@" --port "$PORT"
	"$NODE" "$DIR/src/cli.ts" "$@"
fi
mkdir -p "$DATA_DIR"

# --- Service ---
if [ "$SERVICE" = 1 ]; then
	if [ "$OS" = linux ]; then
		UNIT="$HOME/.config/systemd/user/nhermes.service"
		mkdir -p "$(dirname "$UNIT")"
		cat > "$UNIT" <<EOF
# Written by nhermes scripts/install.sh
[Unit]
Description=nhermes gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=NHERMES_CONFIG=$NHERMES_CONFIG
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE $DIR/src/cli.ts serve
# \`systemctl --user reload nhermes\` re-reads config.yaml.
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
# SIGTERM lets the gateway close the Durable store cleanly.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
		loginctl enable-linger "$(id -un)" 2>/dev/null || say "Could not enable lingering; the service stops when you log out (run: sudo loginctl enable-linger $(id -un))"
		systemctl --user daemon-reload
		systemctl --user enable --quiet nhermes
		systemctl --user restart nhermes
		say "Service: systemctl --user status nhermes · logs: journalctl --user -u nhermes -f"
	else
		LABEL=com.nhermes.gateway
		PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
		mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
		cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array><string>$NODE</string><string>$DIR/src/cli.ts</string><string>serve</string></array>
	<key>WorkingDirectory</key><string>$DIR</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>NHERMES_CONFIG</key><string>$NHERMES_CONFIG</string>
		<key>PATH</key><string>$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$HOME/Library/Logs/nhermes.log</string>
	<key>StandardErrorPath</key><string>$HOME/Library/Logs/nhermes.log</string>
</dict>
</plist>
EOF
		launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
		launchctl bootstrap "gui/$(id -u)" "$PLIST"
		say "Service: launchctl print gui/$(id -u)/$LABEL · logs: ~/Library/Logs/nhermes.log"
	fi

	# Wait for the gateway to answer.
	PORT_NOW=$(sed -n 's/^  port: *\([0-9][0-9]*\).*/\1/p' "$NHERMES_CONFIG" | head -1)
	PORT_NOW=${PORT_NOW:-9119}
	i=0
	until curl -fsS "http://127.0.0.1:$PORT_NOW/api/health" >/dev/null 2>&1; do
		i=$((i + 1))
		[ "$i" -gt 30 ] && die "the gateway did not start; see the logs above"
		sleep 1
	done
	say "Gateway running on port $PORT_NOW"
	if [ -n "$JOIN" ]; then
		"$NODE" "$DIR/src/cli.ts" join "$JOIN" --yes </dev/null
	fi
fi

# --- What next ---
echo
if [ "$FIRST" = 1 ]; then
	cat <<EOF
Installed. Next:
  1. Give it a model: edit $CONF_DIR/config.yaml (defaults.model) and put the provider key in
     $CONF_DIR/secrets.env, or point pi.authPath / pi.modelsPath at a Pi auth.json / models.json.
     Then: $NH reload   (or restart the service)
  2. Open the panel: http://<this machine>:${PORT:-9119}/panel/
  3. Vory: add the gateway with the token NHERMES_TOKEN from $CONF_DIR/secrets.env.
EOF
	[ -z "$JOIN" ] && echo "  4. Join a network: run 'nhermes invite' on a member, then '$NH join <code>' here."
else
	echo "Upgraded. Config and data were left as they were."
fi
echo "Tip: export NHERMES_CONFIG=$NHERMES_CONFIG and add $DIR/bin to your PATH to use 'nhermes' directly."
