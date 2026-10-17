// What an image costs a model in tokens. Providers price images by their pixel size, not by how many
// bytes they encode to, so the size is read from the image's header and run through the provider's
// published formula.

/** Width and height from a base64 PNG, JPEG, GIF or WebP header, or undefined if unreadable. */
export function imageSize(base64: string): { width: number; height: number } | undefined {
	// The header is near the start; JPEG metadata (EXIF) can push its size marker back a way.
	const b = Buffer.from(base64.slice(0, 87_384), "base64");
	if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
	if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
	if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
		const kind = b.toString("latin1", 12, 16);
		if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
		if (kind === "VP8L") {
			const bits = b.readUInt32LE(21);
			return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
		}
		if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
		return undefined;
	}
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) return undefined;
			const marker = b[i + 1]!;
			// SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
			}
			i += 2 + b.readUInt16BE(i + 2);
		}
	}
	return undefined;
}

/**
 * Tokens one image costs on a model of this API: Anthropic's pixels / 750 after fitting 1568 px,
 * Gemini's 258 per 768 px tile, otherwise OpenAI's high-detail tiles (85 + 170 per 512 px tile after
 * fitting 2048 px, then 768 px on the short side). An unreadable image counts as a typical screenshot.
 */
export function imageTokens(base64: string, api: string): number {
	const size = imageSize(base64) ?? { width: 1280, height: 800 };
	let { width: w, height: h } = size;
	if (w <= 0 || h <= 0) return 0;
	if (api === "anthropic-messages" || api === "bedrock-converse-stream") {
		const scale = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)));
		return Math.ceil((w * scale * (h * scale)) / 750);
	}
	if (api.startsWith("google")) {
		if (w <= 384 && h <= 384) return 258;
		return 258 * Math.ceil(w / 768) * Math.ceil(h / 768);
	}
	const fit = Math.min(1, 2048 / Math.max(w, h));
	w *= fit;
	h *= fit;
	const short = Math.min(1, 768 / Math.min(w, h));
	w *= short;
	h *= short;
	return 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512);
}
