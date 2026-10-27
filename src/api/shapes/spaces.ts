// Wire shape of a bot's open space (docs/API.md "Watching a space"): what a client needs to show it and offer a
// view; the Cua sandbox name and the idle clock stay on the gateway.
import type { SpaceInfo } from "../../spaces/spaces.ts";

export type SpaceJson = { id: string; openedAt: number; watching: number; controlling: number };

export function spaceJson(s: SpaceInfo): SpaceJson {
	return { id: s.id, openedAt: s.createdAt, watching: s.watching, controlling: s.controlling };
}
