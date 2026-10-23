// The models a picker offers (the app's, the panel's, the bots' self_models): every available model except
// the providers the owner hid, and always the model already in use.
import type { Models } from "@earendil-works/pi-ai";

export async function pickableModels(models: Models, hidden: readonly string[], current?: { provider: string; modelId: string }) {
	const hide = new Set(hidden);
	return (await models.getAvailable()).filter((m) => !hide.has(m.provider) || (m.provider === current?.provider && m.id === current?.modelId));
}
