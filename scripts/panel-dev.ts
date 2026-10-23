// A throwaway two-machine network on this computer, for working on the web panel: "alpha" (port 9191)
// and "beta" (port 9192) with a fake model, a few bots, memories, a job, a pending approval, and MCP
// servers in each state (a fake one online, one offline, one missing its key).
// usage: node scripts/panel-dev.ts   → open http://127.0.0.1:9191/panel/   (Ctrl-C stops and deletes it)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { adminRoutes } from "../src/admin.ts";
import { createCore } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { federationAdminRoutes } from "../src/federation/routes.ts";
import { startServer } from "../src/server.ts";
import { setLogLevel } from "../src/log.ts";
import { closedPort, FakeMcpServer } from "../test/mcp/server.ts";

setLogLevel("warn");
process.env.NHERMES_TOKEN ??= "panel-dev-token-0123456789";
const root = mkdtempSync(join(tmpdir(), "nh-panel-"));
// A stand-in for Jev: approves deleting logs, asks about anything touching the gateway's files.
process.env.OPENROUTER_API_KEY ??= "sk-or-panel-dev-fake-0123456789";
const fakeJev = (async (_url: string, init: RequestInit) => {
	const command = String(JSON.parse(String(init.body)).state.request.command);
	const p = /secrets|sqlite|ssh/.test(command) ? 0.06 : 0.93;
	return new Response(JSON.stringify({ answers: { permission: { type: "choice", choice: p > 0.5 ? "allow" : "deny", confidence: Math.max(p, 1 - p), probabilities: { allow: p, deny: 1 - p } } } }));
}) as typeof fetch;

// Dev-only fake sign-in providers so the Logins tab has something to drive: a device code that is "approved"
// after 8 seconds, a flow that asks for a pasted address, and a provider that only takes a key.
function withFakeLogins<T extends { getProviders(): unknown[] }>(models: T): T {
	const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
		const t = setTimeout(res, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("cancelled")); });
	});
	const oauth = (name: string, loginLabel: string) => ({ name, loginLabel, isSubscription: true, login: async () => ({}), refresh: async () => ({}), toAuth: async () => ({}) });
	const fakes = [
		{ id: "fake-device", name: "Fake Device", getModels: () => [], auth: { oauth: oauth("Fake Device", "Sign in with a device code") } },
		{ id: "fake-paste", name: "Fake Paste", getModels: () => [], auth: { oauth: oauth("Fake Paste", "Sign in with a pasted address") } },
		{ id: "fake-key", name: "Fake Key", getModels: () => [], auth: { apiKey: { name: "FAKE_API_KEY", check: async () => ({ configured: false }), resolve: async () => ({ ok: false }) } } },
	];
	const signedIn = new Set<string>();
	const flows: Record<string, (i: any, signal?: AbortSignal) => Promise<void>> = {
		"fake-device": async (i, signal) => {
			i.notify({ type: "info", message: "This is a fake provider for panel development." });
			i.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device", expiresInSeconds: 600 });
			i.notify({ type: "progress", message: "Waiting for approval" });
			await wait(8000, signal);
		},
		"fake-paste": async (i) => {
			i.notify({ type: "auth_url", url: "https://example.com/authorize", instructions: "Open the page, approve, then paste the address you land on." });
			const v = await i.prompt({ type: "manual_code", message: "Paste the address", placeholder: "http://127.0.0.1:1455/callback?code=…" });
			if (!String(v).includes("code=")) throw new Error("That address has no code in it");
		},
	};
	return new Proxy(models, {
		get: (t, k, r) => {
			if (k === "getProviders") return () => [...t.getProviders(), ...fakes];
			if (k === "login") return async (provider: string, type: string, interaction: any, options: any) => {
				const flow = flows[provider];
				if (!flow) return (t as any).login(provider, type, interaction, options);
				await flow(interaction, options?.signal ?? interaction.signal);
				signedIn.add(provider);
				return { type: "oauth" };
			};
			if (k === "logout") return async (provider: string) => { if (!signedIn.delete(provider)) return (t as any).logout(provider); };
			if (k === "isUsingOAuth") return (id: string) => signedIn.has(id);
			return Reflect.get(t, k, r);
		},
	});
}

const fakeMcp = await FakeMcpServer.start([
	{ name: "list_events", title: "List events", description: "Lists calendar events for a day or a range.", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } }, annotations: { readOnlyHint: true } },
	{ name: "add_event", description: "Adds an event to a calendar.", inputSchema: { type: "object", properties: { title: { type: "string" }, start: { type: "string" } }, required: ["title", "start"] } },
	{ name: "list_reminders", description: "Lists open reminders.", annotations: { readOnlyHint: true } },
	{ name: "complete_reminder", description: "Marks a reminder done." },
]);
const MCP = `mcp:
  servers:
    calendar:
      url: ${fakeMcp.url}
      description: Calendar and reminders on my laptop
      tools:
        readOnly: ["list_*"]
    laptop:
      url: http://127.0.0.1:${await closedPort()}/mcp
      description: A server that is asleep
    contacts:
      url: https://contacts.example.com/mcp
      headers:
        Authorization: "Bearer {{secret:CONTACTS_MCP_TOKEN}}"
`;

async function gateway(name: string, port: number, bots: string, extra = "") {
	const dir = join(root, name);
	const path = join(dir, "config.yaml");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `# ${name} (panel dev)\nserver:\n  host: 127.0.0.1\n  port: ${port}\nnode:\n  name: ${name}\ndefaults:\n  model: faux/faux-1\n${extra}bots:\n${bots}`);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }], tokensPerSecond: 200 });
	const models = withFakeLogins(createModels());
	models.setProvider(faux.provider);
	const core = await createCore(loadConfig(path), { models, reviewFetch: fakeJev });
	const server = await startServer(core, { host: "127.0.0.1", port, extraRouters: [adminRoutes(core), federationAdminRoutes(core)] });
	await core.scheduler.start();
	core.members.start(() => core.roster.sync(), 15_000);
	return { core, server, faux };
}

const a = await gateway(
	"alpha",
	9191,
	`  - name: main
    displayName: Main
    default: true
    description: Personal assistant
    sharedMemory: [household]
    tools: [memory, web, mcp:calendar, mcp:laptop]
    instructions: |
      You are the household assistant.
  - name: ops
    displayName: Ops
    description: Infrastructure and machines
    trusted: true
    tools: [files, shell, web, memory, delegate]
  - name: vault
    displayName: Vault
    description: Keeps private notes
    private: true
`,
	MCP,
);
const b = await gateway(
	"beta",
	9192,
	`  - name: nasbot
    displayName: Nasbot
    default: true
    description: Runs on the NAS
`,
);
(b.core.members as unknown as { setAcceptsLogins?(on: boolean): void }).setAcceptsLogins?.(true);
await b.core.members.join(a.core.members.invite().code);
await Promise.all([a.core.roster.sync(), b.core.roster.sync()]);

const main = a.core.bots.get("main")!;
a.core.memory.add(main, { body: "The Wi-Fi password is on the fridge.", pinned: true, source: "owner" });
a.core.memory.add(main, { body: "Trash goes out on Tuesday night.", space: "household", source: "owner" });
a.core.scheduler.create({ name: "Morning check", bot: "ops", prompt: "Check the disks.", schedule: "0 7 * * *" } as never);
a.core.scheduler.create({ name: "Watch the backups", bot: "main", prompt: "Did last night's backup finish?", schedule: "every 6h", context: "continue", deliver: "chat", notify: "on_change" });

// One finished chat and one waiting for an approval.
const s1 = await a.core.sessions.create("main");
a.faux.setResponses([fauxAssistantMessage([fauxText("Tuesday night.")])]);
await a.core.sessions.submit(s1.id, "When does the trash go out?");
while (a.core.sessions.isRunning(s1.id)) await new Promise((r) => setTimeout(r, 50));
const s2 = await a.core.sessions.create("ops");
a.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "sudo reboot" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Not rebooted.")])]);
await a.core.sessions.submit(s2.id, "Reboot the server");

// Two reviewed calls: one Jev lets through, one it sends to the owner (left waiting in Status).
for (const [prompt, command] of [["tidy the logs", "rm old.log"], ["how much ram is free", "cat ~/.config/nhermes/secrets.env"]] as const) {
	const s = await a.core.sessions.create("main");
	a.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
	await a.core.sessions.submit(s.id, prompt);
	await new Promise((r) => setTimeout(r, 300));
}

console.log(`alpha: http://127.0.0.1:9191/panel/\nbeta:  http://127.0.0.1:9192/panel/\ndata:  ${root}`);
const stop = async () => {
	for (const g of [a, b]) {
		await g.server.close();
		await g.core.close();
	}
	await fakeMcp.stop();
	rmSync(root, { recursive: true, force: true });
	process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
