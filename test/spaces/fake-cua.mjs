#!/usr/bin/env node
// A stand-in for the cua command: sandboxes are directories under $FAKE_CUA_DIR, and a guest path such as
// /tmp/pi-env is that path inside the sandbox's directory. `exec -i` runs the given argv on this machine, so a
// copied pi-env daemon really runs. Only the subcommands nHermes uses exist.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.env.FAKE_CUA_DIR;
const [, , group, cmd, ...args] = process.argv;
if (!root || group !== "sb") {
	console.error("fake cua: unsupported");
	process.exit(2);
}
const dir = (name) => join(root, name);
const guest = (name, path) => (path.startsWith("/") ? join(dir(name), path) : path);
const need = (name) => {
	if (!existsSync(dir(name))) {
		console.error(`sandbox ${name} not found`);
		process.exit(1);
	}
};

if (cmd === "create") {
	const name = args[args.indexOf("--name") + 1];
	if (existsSync(dir(name))) {
		console.error(`sandbox ${name} already exists`);
		process.exit(1);
	}
	mkdirSync(dir(name), { recursive: true });
	console.log(JSON.stringify({ name, id: `local:${name}`, status: "running", kind: "container", runtime: "fake" }));
} else if (cmd === "ls") {
	const names = existsSync(root) ? readdirSync(root).sort() : [];
	console.log(JSON.stringify(names.map((name) => ({ name, id: `local:${name}`, status: "running", extra: 1 }))));
} else if (cmd === "rm") {
	const name = args.at(-1);
	if (!args.includes("-f")) {
		console.error("no terminal to confirm; use -f");
		process.exit(1);
	}
	need(name);
	rmSync(dir(name), { recursive: true, force: true });
} else if (cmd === "cp") {
	const [from, to] = args;
	const i = to.indexOf(":");
	const name = to.slice(0, i);
	need(name);
	const target = guest(name, to.slice(i + 1));
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(from, target);
} else if (cmd === "exec") {
	const interactive = args[0] === "-i";
	const rest = interactive ? args.slice(1) : args;
	const name = rest[0];
	need(name);
	const argv = rest.slice(rest.indexOf("--") + 1);
	let child;
	if (interactive) {
		child = spawn(guest(name, argv[0]), argv.slice(1), { stdio: "inherit" });
	} else {
		// A shell line; its /tmp paths are the sandbox's.
		child = spawn("sh", ["-c", argv.join(" ").replaceAll("/tmp/", `${dir(name)}/tmp/`)], { stdio: "inherit" });
	}
	child.on("exit", (code) => process.exit(code ?? 1));
} else if (cmd === "view") {
	// A viewer link to $FAKE_CUA_VIEW_PORT (nothing listens on the default), valid for ten minutes.
	need(args[0]);
	const port = process.env.FAKE_CUA_VIEW_PORT ?? "9";
	console.log(JSON.stringify({ name: args[0], url: `http://127.0.0.1:${port}/viewer/#ticket=fake`, expires_at_unix: Math.floor(Date.now() / 1000) + 600 }));
} else {
	console.error(`fake cua: unsupported ${cmd}`);
	process.exit(2);
}
