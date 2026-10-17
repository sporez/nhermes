// Image token estimates come from the pixel size in the header, not from how many bytes the image is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSize, imageTokens } from "../../src/engine/image-tokens.ts";

function png(width: number, height: number, padding = 0): string {
	const b = Buffer.alloc(33 + padding);
	b.writeUInt32BE(0x89504e47, 0);
	b.writeUInt32BE(0x0d0a1a0a, 4);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b.toString("base64");
}

function jpeg(width: number, height: number): string {
	// SOI, an APP0 segment to skip, then SOF0 with the frame size.
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, ...Buffer.alloc(9)]);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]).toString("base64");
}

test("reads PNG and JPEG sizes", () => {
	assert.deepEqual(imageSize(png(1280, 800)), { width: 1280, height: 800 });
	assert.deepEqual(imageSize(jpeg(1920, 1080)), { width: 1920, height: 1080 });
	assert.equal(imageSize(Buffer.from("not an image").toString("base64")), undefined);
});

test("cost follows pixels, not bytes", () => {
	assert.equal(imageTokens(png(1280, 800), "openai-completions"), imageTokens(png(1280, 800, 400_000), "openai-completions"));
});

test("each provider's formula", () => {
	// OpenAI: 1280x800 → 1229x768 → 3x2 tiles.
	assert.equal(imageTokens(png(1280, 800), "openai-completions"), 85 + 170 * 6);
	// Anthropic: fits 1568 px and ~1.15 MP, then pixels / 750.
	assert.equal(imageTokens(png(1000, 1000), "anthropic-messages"), 1334);
	assert.ok(imageTokens(png(4000, 3000), "anthropic-messages") <= 1534);
	// Gemini: one tile when small, 258 per 768 px tile otherwise.
	assert.equal(imageTokens(png(300, 300), "google-generative-ai"), 258);
	assert.equal(imageTokens(png(1280, 800), "google-generative-ai"), 258 * 4);
});
