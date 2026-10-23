// The models a bot can use (docs/API.md "Models"): what the gateway's providers offer, minus the providers the
// owner hid, grouped by provider, with what each model can do.
import { THINKING_LEVELS } from "../../config.ts";
import { pickableModels } from "../../models/pickable.ts";
import { botOf } from "../lookup.ts";
import type { Op } from "../ops.ts";

export const modelOps: Op[] = [
	{
		name: "models.list",
		http: "GET /models",
		members: true,
		handle: async (p, cx) => {
			const bot = botOf(cx, p.optStr("botId"));
			if (bot.remote) return cx.core.memberChats.forBot(bot, "models.list", {});
			const current = bot.model;
			const models = await pickableModels(cx.core.models, cx.core.config.modelLists.hide, current);
			const byProvider = new Map<string, typeof models>();
			for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
			return {
				providers: [...byProvider].map(([id, list]) => ({
					id,
					name: (cx.core.models.getProvider(id) as { name?: string } | undefined)?.name ?? id,
					models: list.map((m) => ({
						id: m.id,
						name: m.name ?? m.id,
						reasoning: m.reasoning === true,
						thinkingLevels: m.reasoning === true ? THINKING_LEVELS : ["off"],
						input: m.input,
						contextWindow: m.contextWindow ?? 0,
					})),
				})),
				current: { provider: current.provider, id: current.modelId },
			};
		},
	},
];
