// The one image processor the gateway uses: Pi Durable's Photon one, which turns photos upright, converts
// formats providers do not take inline and shrinks them to the model limits. Photon starts on first use,
// in a worker thread that exits when idle, so a gateway that never sees an image never loads it.
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor, type PreparedImage } from "@earendil-works/pi-durable/tools";

let loading: Promise<ImageProcessor> | undefined;

export const images: ImageProcessor = {
	async prepare(bytes, mimeType, limits) {
		loading ??= import("@earendil-works/pi-durable/images/node").then((m) => m.createNodePhotonImages());
		// A plain copy: the worker transfers `bytes.slice()`, and a Node Buffer's slice is a view into a shared pool,
		// which cannot be transferred (the post throws and leaves the worker holding the process open).
		return (await loading).prepare(bytes instanceof Buffer ? new Uint8Array(bytes) : bytes, mimeType, limits);
	},
};

/** An image within the default model limits, or undefined when it cannot be decoded or made to fit. */
export function prepareImage(bytes: Uint8Array, mimeType: string): Promise<PreparedImage | undefined> {
	return images.prepare(bytes, mimeType, DEFAULT_IMAGE_LIMITS);
}
