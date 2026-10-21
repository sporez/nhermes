import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { prepareImage } from "../../src/engine/images.ts";
import { imageSize } from "../../src/engine/image-tokens.ts";
import { collect, fauxModels, pngBytes, tempDir, testCore } from "../helpers.ts";

test("an oversized picture is shrunk to the model limits; a small one passes as it is", async () => {
	const big = await prepareImage(pngBytes(3000, 40), "image/png");
	assert.ok(big);
	assert.deepEqual(big.resized?.to, { width: 2000, height: 27 });
	assert.deepEqual(imageSize(big.data), { width: 2000, height: 27 });
	const small = pngBytes(20, 10);
	const same = await prepareImage(small, "image/png");
	assert.equal(same?.data, small.toString("base64"));
	assert.equal(await prepareImage(Buffer.from("not an image"), "image/png"), undefined);
});

test("a prompt with a picture reaches the model with its image block and is kept in the transcript", async () => {
	const { dir, cleanup } = await tempDir();
	const { models, faux } = fauxModels();
	const core = await testCore(dir, { models });
	try {
		const s = await core.sessions.create("main");
		const c = collect(core.hub, s.id);
		const data = pngBytes(4, 4).toString("base64");
		let seen: unknown[] = [];
		faux.setResponses([
			(context) => {
				const last = context.messages.at(-1);
				seen = last && last.role === "user" && Array.isArray(last.content) ? last.content : [];
				return fauxAssistantMessage("A grey square.");
			},
		]);
		await core.sessions.submit(s.id, [
			{ type: "text", text: "What is this?" },
			{ type: "image", data, mimeType: "image/png" },
		]);
		await c.until((e) => e.type === "run.finished");
		assert.deepEqual(seen, [
			{ type: "text", text: "What is this?" },
			{ type: "image", data, mimeType: "image/png" },
		]);
		const entries = await core.engine.entries(s.conversation_id);
		const user = entries.find((e) => (e.model?.[0] as { role?: string } | undefined)?.role === "user");
		const content = (user?.model?.[0] as { content: { type: string }[] }).content;
		assert.deepEqual(content.map((b) => b.type), ["text", "image"]);
	} finally {
		await core.close();
		await cleanup();
	}
});
