// Builds a Pi models.json provider entry for Neuralwatt from its live /v1/models list (names, vision,
// reasoning efforts, limits, prices). The key stays out of the file: apiKey is "$NEURALWATT_API_KEY".
// usage: NEURALWATT_API_KEY=... node scripts/neuralwatt-models.ts > models.json
const key = process.env.NEURALWATT_API_KEY;
if (!key) throw new Error("set NEURALWATT_API_KEY");

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

const res = await fetch("https://api.neuralwatt.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) throw new Error(`Neuralwatt answered ${res.status}`);
const data = ((await res.json()) as { data: NwModel[] }).data;

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const models = data
	.filter((m) => m.metadata?.capabilities?.tools !== false)
	.map((m) => {
		const md = m.metadata ?? {};
		const caps = md.capabilities ?? {};
		const accepted = new Set(md.reasoning?.accepted_efforts ?? []);
		const reasoning = caps.reasoning === true;
		const out: Record<string, unknown> = {
			id: m.id,
			name: md.display_name ? `${md.display_name}${m.id.endsWith("-flex") ? " (flex)" : m.id.endsWith("-fast") || m.id.endsWith("-speed") ? " (fast)" : ""}` : m.id,
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
			out.thinkingLevelMap = map;
		}
		return out;
	});

const config = {
	providers: {
		neuralwatt: {
			name: "Neuralwatt",
			baseUrl: "https://api.neuralwatt.com/v1",
			api: "openai-completions",
			apiKey: "$NEURALWATT_API_KEY",
			authHeader: true,
			compat: { supportsDeveloperRole: false },
			models,
		},
	},
};
process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
process.stderr.write(`${models.length} Neuralwatt models\n`);
