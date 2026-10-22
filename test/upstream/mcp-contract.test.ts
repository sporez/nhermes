// Pins what src/mcp/ relies on in pi-mcp 1.2.0 and in Pi Durable's registry and argument validation.
// The outcome classifier (src/mcp/outcome.ts) maps these exact error shapes, so a Pi upgrade that changes
// one fails here first. Run first after any Pi upgrade.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { createRegistry, defineExtension, Harness, MemoryStorage, type ToolRegistration } from "@earendil-works/pi-durable";
import { McpAuthRequiredError, McpClient, McpError, McpHttpError, McpSessionExpiredError, McpTimeoutError, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { closedPort, FakeMcpServer } from "../mcp/server.ts";

const ctx = BACKGROUND_CONTEXT;

async function connected(server: FakeMcpServer, requestTimeoutMs = 2000): Promise<McpClient> {
	const client = new McpClient({ name: "contract", version: "1", requestTimeoutMs });
	await client.connect(new StreamableHttpTransport({ url: server.url, openGetStream: false }));
	return client;
}

const causeCode = (e: unknown) => ((e as { cause?: { code?: string } }).cause?.code ?? "") as string;

test("pi-mcp: a refused connection is a TypeError whose cause is ECONNREFUSED", async () => {
	const client = new McpClient({ name: "contract", version: "1" });
	await assert.rejects(client.connect(new StreamableHttpTransport({ url: `http://127.0.0.1:${await closedPort()}/mcp` })), (e: unknown) => e instanceof TypeError && causeCode(e) === "ECONNREFUSED");
});

test("pi-mcp: failures of one call leave the client connected, and a POST is never sent twice", async () => {
	const server = await FakeMcpServer.start([{ name: "t" }]);
	const client = await connected(server, 300);
	try {
		server.behavior.set("t", { drop: true });
		await assert.rejects(client.callTool("t", {}), (e: unknown) => e instanceof TypeError && ["UND_ERR_SOCKET", "ECONNRESET"].includes(causeCode(e)));
		assert.equal(server.callsOf("t").length, 1, "a dropped POST is not resent");

		server.behavior.set("t", { status: 401 });
		await assert.rejects(client.callTool("t", {}), (e: unknown) => e instanceof McpAuthRequiredError);
		server.behavior.set("t", { status: 500, body: "boom" });
		await assert.rejects(client.callTool("t", {}), (e: unknown) => e instanceof McpHttpError && e.status === 500);
		server.behavior.set("t", { rpcError: { code: -32602, message: "bad args" } });
		await assert.rejects(client.callTool("t", {}), (e: unknown) => e instanceof McpError && e.code === -32602);

		// A response stream that breaks before the answer becomes a synthesized internal error with this prefix.
		server.behavior.set("t", { sseDrop: true });
		await assert.rejects(client.callTool("t", {}), (e: unknown) => e instanceof McpError && e.code === -32603 && e.message.startsWith("MCP response stream failed"));

		server.behavior.set("t", { hang: true });
		const cancel = server.next("cancel");
		await assert.rejects(client.callTool("t", {}), (e: unknown) => e instanceof McpTimeoutError);
		await cancel;
		assert.equal(client.connectionState, "connected");
		assert.equal(server.callsOf("t").length, 6, "every call reached the server exactly once");

		server.expireSessions();
		server.behavior.set("t", { text: "fine" });
		await assert.rejects(client.callTool("t", {}), (e: unknown) => e instanceof McpSessionExpiredError);
		assert.equal(server.callsOf("t").length, 6, "an expired session's request is refused before the tool runs");
	} finally {
		await client.close();
		await server.stop();
	}
});

test("pi-mcp: a server that went away fails the next request with a network TypeError, not a close", async () => {
	const server = await FakeMcpServer.start([{ name: "t" }]);
	const client = await connected(server);
	await server.stop();
	try {
		await assert.rejects(client.ping({ timeoutMs: 2000 }), (e: unknown) => e instanceof TypeError);
		assert.equal(client.connectionState, "connected");
	} finally {
		await client.close();
	}
});

test("pi-mcp: tools/list follows pages", async () => {
	const server = await FakeMcpServer.start(Array.from({ length: 5 }, (_, i) => ({ name: `t${i}` })));
	server.pageSize = 2;
	const client = await connected(server);
	try {
		assert.deepEqual((await client.listTools()).map((t) => t.name), ["t0", "t1", "t2", "t3", "t4"]);
	} finally {
		await client.close();
		await server.stop();
	}
});

test("durable: re-installing an extension swaps a tool's implementation; a removed tool answers tool_unavailable and the run goes on", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const registry = createRegistry();
	const tool = (version: string): ToolRegistration => ({
		name: "mcp__x__t",
		description: "t",
		parameters: { type: "object", properties: {} } as unknown as ToolRegistration["parameters"],
		execute: async () => ({ output: [{ type: "text", text: version }] }),
	});
	registry.install(defineExtension({ name: "mcp", tools: [tool("v1")] }));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	try {
		const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id }, tools: [tool("v1")] } }, ctx);
		const run = async (): Promise<{ text: string; isError: boolean }> => {
			faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__x__t", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("done")])]);
			const sub = await conv.submit({ type: "input", content: "go" }, ctx);
			assert.equal((await sub.wait(ctx)).status, "done");
			const page = await conv.entries({ order: "descending" }, 20, undefined, ctx);
			const result = page.items.flatMap((e) => (e.model ?? []) as readonly { role?: string; content?: { type: string; text?: string }[]; isError?: boolean }[]).find((m) => m.role === "toolResult");
			return { text: (result?.content ?? []).map((b) => b.text ?? "").join(""), isError: result?.isError === true };
		};
		assert.deepEqual(await run(), { text: "v1", isError: false });
		registry.install(defineExtension({ name: "mcp", tools: [tool("v2")] }));
		assert.deepEqual(await run(), { text: "v2", isError: false });
		registry.install(defineExtension({ name: "mcp", tools: [] }));
		const gone = await run();
		assert.equal(gone.isError, true);
		assert.match(gone.text, /not available/);
	} finally {
		await harness.close(ctx);
	}
});

test("pi-ai: plain JSON Schema with $defs/$ref and oneOf validates tool arguments", () => {
	const parameters = {
		type: "object",
		$defs: { when: { type: "string", description: "ISO date" } },
		properties: {
			title: { type: "string" },
			due: { $ref: "#/$defs/when" },
			repeat: { oneOf: [{ type: "string", enum: ["daily", "weekly"] }, { type: "integer", minimum: 1 }] },
		},
		required: ["title"],
	};
	const tool = { name: "t", description: "t", parameters } as unknown as Parameters<typeof validateToolArguments>[0];
	type Args = Parameters<typeof validateToolArguments>[1]["arguments"];
	const call = (args: Record<string, unknown>) => validateToolArguments(tool, { type: "toolCall", id: "c", name: "t", arguments: args as Args });
	assert.deepEqual(call({ title: "x", due: "2026-10-22", repeat: "daily" }), { title: "x", due: "2026-10-22", repeat: "daily" });
	assert.equal((call({ title: "x", repeat: 3 }) as { repeat: unknown }).repeat, 3);
	assert.throws(() => call({ due: "2026-10-22" }));
	assert.throws(() => call({ title: "x", repeat: "hourly" }));
});
