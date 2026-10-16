// Providers whose models come from the provider itself: set the provider's key (panel Keys, Vory,
// `nhermes secret set`) and its models appear in the pickers, with nothing to write in models.json.
// Each provider is a small adapter (neuralwatt.ts is the model; add new ones to CATALOGS). Its list is
// fetched when the key is set, at start and every 12 hours, kept in app.sqlite so a start without the
// network still has it, and registered with Pi as an extension provider. A provider that models.json
// defines itself is left to models.json, so a hand-tuned entry is never replaced.
import { readFileSync } from "node:fs";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { logger } from "../log.ts";
import type { AppDb } from "../store/db.ts";
import { neuralwatt } from "./neuralwatt.ts";

const log = logger("catalogs");

export type ProviderCatalog = {
	/** The provider id in model refs ("neuralwatt/<model>"). */
	id: string;
	/** Display name in pickers and the Keys tab. */
	name: string;
	/** The secret that turns it on; Pi reads it from the environment as $NAME on every request. */
	keyEnv: string;
	/** How requests are made: everything but the name, key and models. */
	provider: Omit<ProviderConfig, "name" | "apiKey" | "models" | "refreshModels">;
	/** The live model list in Pi's form. */
	fetchModels(key: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<ProviderModelConfig[]>;
};

export const CATALOGS: ProviderCatalog[] = [neuralwatt];

/** The part of Pi's ModelRuntime this needs (test model sets do not have it, and get no catalogs). */
export type ProviderRegistry = {
	registerProvider(id: string, config: ProviderConfig): void;
	unregisterProvider(id: string): void;
};

export function isProviderRegistry(models: unknown): models is ProviderRegistry {
	const m = models as Partial<ProviderRegistry>;
	return typeof m.registerProvider === "function" && typeof m.unregisterProvider === "function";
}

export type CatalogStatus = { id: string; name: string; keyEnv: string; active: boolean; models: number; fetchedAt: number | null; error: string | null; managedBy: "catalog" | "models.json" };

type Cached = { fetchedAt: number; models: ProviderModelConfig[] };

const REFRESH_MS = 12 * 3600_000;
const FETCH_TIMEOUT_MS = 15_000;

export class ProviderCatalogs {
	private readonly registry: ProviderRegistry | undefined;
	private readonly db: AppDb;
	private readonly modelsPath: string;
	private readonly catalogs: ProviderCatalog[];
	private readonly fetchFn: typeof fetch;
	private readonly registered = new Set<string>();
	private readonly errors = new Map<string, string>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(o: { models: unknown; db: AppDb; modelsPath: string; catalogs?: ProviderCatalog[]; fetch?: typeof fetch }) {
		this.registry = isProviderRegistry(o.models) ? o.models : undefined;
		this.db = o.db;
		this.modelsPath = o.modelsPath;
		this.catalogs = o.catalogs ?? CATALOGS;
		this.fetchFn = o.fetch ?? fetch;
	}

	/** Keys the catalogs read, for the Keys tab. */
	keys(): { name: string; provider: string; providerName: string }[] {
		return this.catalogs.map((c) => ({ name: c.keyEnv, provider: c.id, providerName: c.name }));
	}

	/**
	 * Registers every provider whose key is set from its stored list, so models chats already use resolve
	 * at once; a provider never fetched before is fetched now (bounded, so a dead network does not hold
	 * the start up). Then refreshes in the background and every 12 hours.
	 */
	async start(): Promise<void> {
		if (!this.registry) return;
		const first: Promise<void>[] = [];
		for (const c of this.catalogs) {
			if (!this.usable(c)) continue;
			const cached = this.cached(c.id);
			if (cached) this.register(c, cached.models);
			else first.push(this.refreshOne(c));
		}
		await Promise.race([Promise.allSettled(first), new Promise((r) => setTimeout(r, FETCH_TIMEOUT_MS).unref())]);
		setTimeout(() => void this.refresh(), 5_000).unref();
		this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** A secret changed: a catalog's key set means fetch its list now; removed means its models leave the pickers. */
	keyChanged(name: string): void {
		if (!this.registry) return;
		for (const c of this.catalogs) {
			if (c.keyEnv !== name) continue;
			if (process.env[name]) void this.refreshOne(c);
			else this.unregister(c);
		}
	}

	/** Fetches every catalog whose key is set; failures keep the list already registered. */
	async refresh(): Promise<void> {
		await Promise.allSettled(this.catalogs.filter((c) => this.usable(c)).map((c) => this.refreshOne(c)));
	}

	status(): CatalogStatus[] {
		const defined = this.definedInModelsJson();
		return this.catalogs.map((c) => {
			const cached = this.cached(c.id);
			return {
				id: c.id,
				name: c.name,
				keyEnv: c.keyEnv,
				active: this.registered.has(c.id),
				models: cached?.models.length ?? 0,
				fetchedAt: cached?.fetchedAt ?? null,
				error: this.errors.get(c.id) ?? null,
				managedBy: defined.has(c.id) ? "models.json" : "catalog",
			};
		});
	}

	private usable(c: ProviderCatalog): boolean {
		if (!process.env[c.keyEnv]) return false;
		if (this.definedInModelsJson().has(c.id)) {
			log.info("models.json defines this provider; its own list is not used", { provider: c.id });
			return false;
		}
		return true;
	}

	private refreshOne(c: ProviderCatalog): Promise<void> {
		const running = this.inFlight.get(c.id);
		if (running) return running;
		const p = (async () => {
			const key = process.env[c.keyEnv];
			if (!key || this.definedInModelsJson().has(c.id)) return;
			try {
				const models = await c.fetchModels(key, this.fetchFn, AbortSignal.timeout(FETCH_TIMEOUT_MS));
				if (models.length === 0) throw new Error("the provider listed no models");
				// The key may have been removed while the list was on its way.
				if (!process.env[c.keyEnv]) return;
				this.db.run(
					"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					`catalog.${c.id}`,
					JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000), models } satisfies Cached),
				);
				this.register(c, models);
				this.errors.delete(c.id);
				log.info("model list updated", { provider: c.id, models: models.length });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.errors.set(c.id, message);
				log.warn("could not fetch the model list; keeping the last one", { provider: c.id, error: message });
			}
		})().finally(() => this.inFlight.delete(c.id));
		this.inFlight.set(c.id, p);
		return p;
	}

	private register(c: ProviderCatalog, models: ProviderModelConfig[]): void {
		try {
			this.registry!.registerProvider(c.id, { ...c.provider, name: c.name, apiKey: `$${c.keyEnv}`, models });
			this.registered.add(c.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.errors.set(c.id, message);
			log.warn("Pi refused the provider", { provider: c.id, error: message });
		}
	}

	private unregister(c: ProviderCatalog): void {
		if (!this.registered.delete(c.id)) return;
		this.registry!.unregisterProvider(c.id);
		log.info("key removed; models withdrawn", { provider: c.id });
	}

	private cached(id: string): Cached | undefined {
		const raw = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `catalog.${id}`)?.value;
		if (!raw) return undefined;
		try {
			const c = JSON.parse(raw) as Cached;
			return Array.isArray(c.models) && c.models.length > 0 ? c : undefined;
		} catch {
			return undefined;
		}
	}

	private definedInModelsJson(): Set<string> {
		try {
			const doc = JSON.parse(readFileSync(this.modelsPath, "utf8")) as { providers?: Record<string, unknown> };
			return new Set(Object.keys(doc.providers ?? {}));
		} catch {
			return new Set();
		}
	}
}
