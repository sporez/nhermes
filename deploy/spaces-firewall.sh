#!/bin/sh
# Keeps Cua spaces (Docker containers on this host) off the private network: a space reaches the internet
# and the host's DNS servers, never this host's own ports or another LAN address. Idempotent; run as root.
# `start` (default) installs or refreshes the rules, `stop` removes them, `status` prints them.
# Installed and explained in docs/SPACES.md ("Network isolation").
set -eu

IPT="iptables -w"
FWD=NHERMES-SPACES-FWD
IN=NHERMES-SPACES-IN
BRIDGES="docker0 br-+"
PRIVATE="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16"

# The DNS servers containers are given: Docker copies the host's upstream servers when the host
# itself uses a loopback stub (systemd-resolved).
dns_servers() {
	f=/run/systemd/resolve/resolv.conf
	[ -r "$f" ] || f=/etc/resolv.conf
	awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ && $2 !~ /^127\./ { print $2 }' "$f"
}

unhook() {
	for b in $BRIDGES; do
		while $IPT -C DOCKER-USER -i "$b" -j "$FWD" 2>/dev/null; do $IPT -D DOCKER-USER -i "$b" -j "$FWD"; done
		while $IPT -C INPUT -i "$b" -j "$IN" 2>/dev/null; do $IPT -D INPUT -i "$b" -j "$IN"; done
	done
}

start() {
	$IPT -n -L DOCKER-USER >/dev/null 2>&1 || { echo "spaces-firewall: no DOCKER-USER chain; is Docker running?" >&2; exit 1; }
	$IPT -N "$FWD" 2>/dev/null || $IPT -F "$FWD"
	$IPT -N "$IN" 2>/dev/null || $IPT -F "$IN"

	# Forwarded traffic: replies, then DNS to the host's resolvers, then nothing private.
	$IPT -A "$FWD" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
	for ns in $(dns_servers); do
		$IPT -A "$FWD" -d "$ns" -p udp --dport 53 -j RETURN
		$IPT -A "$FWD" -d "$ns" -p tcp --dport 53 -j RETURN
	done
	$IPT -A "$FWD" -d "$PRIVATE" -j DROP

	# Traffic to this host (the gateway, SSH, …): only replies to connections the host opened.
	$IPT -A "$IN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
	$IPT -A "$IN" -j DROP

	unhook
	for b in $BRIDGES; do
		$IPT -I DOCKER-USER 1 -i "$b" -j "$FWD"
		$IPT -I INPUT 1 -i "$b" -j "$IN"
	done
}

stop() {
	unhook
	for c in "$FWD" "$IN"; do $IPT -F "$c" 2>/dev/null && $IPT -X "$c" 2>/dev/null || true; done
}

case "${1:-start}" in
start) start ;;
stop) stop ;;
status) $IPT -S DOCKER-USER; $IPT -S "$FWD"; $IPT -S INPUT | grep -F "$IN" || true; $IPT -S "$IN" ;;
*) echo "usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac
