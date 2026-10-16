// Neuralwatt: an OpenAI-compatible provider whose /v1/models list carries names, vision, reasoning
// efforts, limits and prices, so its whole catalogue can be built from that one call.
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ProviderCatalog } from "./catalogs.ts";

type NwModel = {
	id: string;
	max_model_len?: number;
	metadata?: {
		display_name?: string;
		pricing?: { input_per_million?: number | null; output_per_million?: number | null; cached_input_per_million?: number | null };
		capabilities?: { tools?: boolean; vision?: boolean; reasoning?: boolean; reasoning_effort?: boolean; developer_role?: boolean };
		reasoning?: { accepted_efforts?: string[] };
		limits?: { max_context_length?: number; max_output_tokens?: number };
	};
};

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Pi model entries for the models that can call tools (a bot without tools is no use here). */
export function neuralwattModels(data: NwModel[]): ProviderModelConfig[] {
	return data
		.filter((m) => m.metadata?.capabilities?.tools !== false)
		.map((m) => {
			const md = m.metadata ?? {};
			const caps = md.capabilities ?? {};
			const accepted = new Set(md.reasoning?.accepted_efforts ?? []);
			const reasoning = caps.reasoning === true;
			const suffix = m.id.endsWith("-flex") ? " (flex)" : m.id.endsWith("-fast") || m.id.endsWith("-speed") ? " (fast)" : "";
			const out: ProviderModelConfig = {
				id: m.id,
				name: md.display_name ? `${md.display_name}${suffix}` : m.id,
				reasoning,
				input: caps.vision ? ["text", "image"] : ["text"],
				contextWindow: md.limits?.max_context_length ?? m.max_model_len ?? 131072,
				maxTokens: Math.min(md.limits?.max_output_tokens ?? 32768, 65536),
				cost: {
					input: md.pricing?.input_per_million ?? 0,
					output: md.pricing?.output_per_million ?? 0,
					cacheRead: md.pricing?.cached_input_per_million ?? md.pricing?.input_per_million ?? 0,
					cacheWrite: 0,
				},
				compat: { supportsDeveloperRole: caps.developer_role === true, supportsReasoningEffort: caps.reasoning_effort === true },
			};
			if (reasoning && caps.reasoning_effort) {
				const map: Record<string, string | null> = {};
				for (const l of LEVELS) {
					const wire = l === "off" ? "none" : l;
					map[l] = accepted.has(wire) ? wire : null;
				}
				out.thinkingLevelMap = map as typeof out.thinkingLevelMap;
			}
			return out;
		});
}

export const neuralwatt: ProviderCatalog = {
	id: "neuralwatt",
	name: "Neuralwatt",
	keyEnv: "NEURALWATT_API_KEY",
	provider: {
		baseUrl: "https://api.neuralwatt.com/v1",
		api: "openai-completions",
		authHeader: true,
	},
	async fetchModels(key, fetchFn, signal) {
		const res = await fetchFn("https://api.neuralwatt.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal });
		if (!res.ok) throw new Error(`Neuralwatt answered ${res.status}`);
		return neuralwattModels(((await res.json()) as { data: NwModel[] }).data);
	},
};
