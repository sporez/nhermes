// Reading an operation's parameters. HTTP merges the path, the query and a JSON body into one object; the
// WebSocket sends it as is. So a value may arrive as a string (query) or as its JSON type (body, socket),
// and readers accept both. Unknown parameters are ignored (docs/API.md "Evolution").
import { ApiError } from "./errors.ts";

export class Params {
	readonly raw: Record<string, unknown>;

	constructor(raw: unknown) {
		this.raw = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	}

	has(key: string): boolean {
		return this.raw[key] !== undefined && this.raw[key] !== null;
	}

	str(key: string): string {
		const v = this.optStr(key);
		if (v === undefined || v === "") throw new ApiError("invalid_params", `${key} is required.`);
		return v;
	}

	optStr(key: string): string | undefined {
		const v = this.raw[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "string") throw new ApiError("invalid_params", `${key} must be text.`);
		return v;
	}

	optInt(key: string, o: { min?: number; max?: number } = {}): number | undefined {
		const v = this.raw[key];
		if (v === undefined || v === null || v === "") return undefined;
		const n = typeof v === "string" ? Number(v) : v;
		if (typeof n !== "number" || !Number.isInteger(n)) throw new ApiError("invalid_params", `${key} must be a whole number.`);
		if (o.min !== undefined && n < o.min) throw new ApiError("invalid_params", `${key} must be at least ${o.min}.`);
		if (o.max !== undefined && n > o.max) throw new ApiError("invalid_params", `${key} must be at most ${o.max}.`);
		return n;
	}

	optBool(key: string): boolean | undefined {
		const v = this.raw[key];
		if (v === undefined || v === null || v === "") return undefined;
		if (v === true || v === "true") return true;
		if (v === false || v === "false") return false;
		throw new ApiError("invalid_params", `${key} must be true or false.`);
	}

	optEnum<T extends string>(key: string, values: readonly T[]): T | undefined {
		const v = this.optStr(key);
		if (v === undefined) return undefined;
		if (!values.includes(v as T)) throw new ApiError("invalid_params", `${key} must be one of: ${values.join(", ")}.`);
		return v as T;
	}

	/** A list: a JSON array, or a comma-separated query value. */
	optList(key: string): string[] | undefined {
		const v = this.raw[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
		if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
		throw new ApiError("invalid_params", `${key} must be a list of text.`);
	}

	optObject(key: string): Record<string, unknown> | undefined {
		const v = this.raw[key];
		if (v === undefined || v === null) return undefined;
		if (typeof v !== "object" || Array.isArray(v)) throw new ApiError("invalid_params", `${key} must be an object.`);
		return v as Record<string, unknown>;
	}
}
