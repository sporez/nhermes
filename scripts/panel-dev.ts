// A throwaway two-machine network on this computer, for working on the web panel: "alpha" (port 9191)
// and "beta" (port 9192) with a fake model, a few bots, memories, a job and a pending approval.
// usage: node scripts/panel-dev.ts   → open http://127.0.0.1:9191/panel/   (Ctrl-C stops and deletes it)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { adminRoutes } from "../src/admin.ts";
import { createCore } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { federationAdminRoutes } from "../src/federation/routes.ts";
import { startHermesServer } from "../src/hermes/server.ts";
import { setLogLevel } from "../src/log.ts";

setLogLevel("warn");
process.env.NHERMES_TOKEN ??= "panel-dev-token-0123456789";
const root = mkdtempSync(join(tmpdir(), "nh-panel-"));

async function gateway(name: string, port: number, bots: string) {
	const dir = join(root, name);
	const path = join(dir, "config.yaml");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `# ${name} (panel dev)\nserver:\n  host: 127.0.0.1\n  port: ${port}\nnode:\n  name: ${name}\ndefaults:\n  model: faux/faux-1\nbots:\n${bots}`);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }], tokensPerSecond: 200 });
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await createCore(loadConfig(path), { models });
	const server = await startHermesServer(core, { host: "127.0.0.1", port, extraRouters: [adminRoutes(core), federationAdminRoutes(core)] });
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
await b.core.members.join(a.core.members.invite().code);
await Promise.all([a.core.roster.sync(), b.core.roster.sync()]);

const main = a.core.bots.get("main")!;
a.core.memory.add(main, { body: "The Wi-Fi password is on the fridge.", pinned: true, source: "owner" });
a.core.memory.add(main, { body: "Trash goes out on Tuesday night.", space: "household", source: "owner" });
a.core.scheduler.create({ name: "Morning check", bot: "ops", prompt: "Check the disks.", schedule: "0 7 * * *" } as never);

// One finished chat and one waiting for an approval.
const s1 = await a.core.sessions.create("main");
a.faux.setResponses([fauxAssistantMessage([fauxText("Tuesday night.")])]);
await a.core.sessions.submit(s1.id, "When does the trash go out?");
while (a.core.sessions.isRunning(s1.id)) await new Promise((r) => setTimeout(r, 50));
const s2 = await a.core.sessions.create("ops");
a.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "sudo reboot" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Not rebooted.")])]);
await a.core.sessions.submit(s2.id, "Reboot the server");

console.log(`alpha: http://127.0.0.1:9191/panel/\nbeta:  http://127.0.0.1:9192/panel/\ndata:  ${root}`);
const stop = async () => {
	for (const g of [a, b]) {
		await g.server.close();
		await g.core.close();
	}
	rmSync(root, { recursive: true, force: true });
	process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
