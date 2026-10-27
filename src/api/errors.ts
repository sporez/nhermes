// The client API's errors (docs/API.md "Errors"): a stable string code with its HTTP status, and a message
// a person can read. Core services throw their own error classes; `apiError` turns them into these, in one
// place, so every route and socket answers the same way.
import { AttachmentError } from "../core/attachments.ts";
import { UnknownBot } from "../core/bots.ts";
import { RoomError } from "../core/rooms.ts";
import { JobError } from "../core/scheduler.ts";
import { SecretError } from "../core/secrets.ts";
import { UnknownSession } from "../core/sessions.ts";
import { UpdateError } from "../core/updates.ts";
import { ConfigError } from "../config.ts";
import { FederationError } from "../federation/members.ts";
import { UnknownMcpServer } from "../mcp/manage.ts";
import { UnknownSkill } from "../skills/skills.ts";
import { HttpError } from "../http.ts";
import { DeviceError } from "../notify/devices.ts";
import { RemoteError } from "../remote/api-client.ts";
import { CuaMissing } from "../spaces/cua.ts";
import { SpaceGone } from "../spaces/spaces.ts";

/** Every error code the API answers with, and its HTTP status. Codes are only ever added. */
export const ERROR_STATUS = {
	invalid_params: 400,
	unauthorized: 401,
	not_allowed: 403,
	not_found: 404,
	unknown_op: 404,
	bot_not_found: 404,
	session_not_found: 404,
	approval_not_found: 404,
	method_not_allowed: 405,
	conflict: 409,
	too_large: 413,
	unsupported_media: 415,
	internal: 500,
	member_offline: 502,
	not_available: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
	readonly code: ErrorCode;
	readonly details: Record<string, unknown> | undefined;
	constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.code = code;
		this.details = details;
	}

	get status(): number {
		return ERROR_STATUS[this.code];
	}

	toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
		return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
	}
}

/** The nearest code for an HTTP status a core service chose. */
function codeOfStatus(status: number): ErrorCode {
	if (status === 400 || status === 422) return "invalid_params";
	if (status === 401) return "unauthorized";
	if (status === 403) return "not_allowed";
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status === 413) return "too_large";
	if (status === 415) return "unsupported_media";
	if (status === 502 || status === 504) return "member_offline";
	if (status === 503) return "not_available";
	return "internal";
}

/** Any error a handler threw, as the API's error; undefined for one that is a bug (logged and answered as internal). */
export function apiError(error: unknown): ApiError | undefined {
	if (error instanceof ApiError) return error;
	if (error instanceof UnknownSession) return new ApiError("session_not_found", `No chat with id ${error.sessionId}.`);
	if (error instanceof UnknownBot) return new ApiError("bot_not_found", error.message);
	if (error instanceof ConfigError) return new ApiError("invalid_params", error.message);
	if (error instanceof HttpError || error instanceof JobError || error instanceof SecretError || error instanceof UpdateError) return new ApiError(codeOfStatus(error.status), error.message);
	if (error instanceof FederationError) return new ApiError(error.status === 401 ? "member_offline" : codeOfStatus(error.status), error.message);
	if (error instanceof UnknownSkill) return new ApiError("not_found", error.message);
	if (error instanceof UnknownMcpServer) return new ApiError("not_found", error.message);
	if (error instanceof SpaceGone) return new ApiError("not_found", error.message);
	if (error instanceof CuaMissing) return new ApiError("not_available", "Spaces are not set up on this machine.");
	// A member's answer keeps its own code; a lost link is the member being offline.
	if (error instanceof RemoteError) return new ApiError(error.code in ERROR_STATUS ? (error.code as ErrorCode) : "member_offline", error.message);
	if (error instanceof DeviceError) return new ApiError("invalid_params", error.message);
	if (error instanceof AttachmentError) return new ApiError(ATTACHMENT_CODES[error.code] ?? "invalid_params", error.message);
	if (error instanceof RoomError) return new ApiError(ROOM_CODES[error.code] ?? "invalid_params", error.message);
	return undefined;
}

/** The numeric codes core/attachments.ts and core/rooms.ts throw (their own codes, from before the client API). */
const ATTACHMENT_CODES: Record<number, ErrorCode> = { 4016: "unsupported_media", 4017: "too_large", 4019: "not_available" };
const ROOM_CODES: Record<number, ErrorCode> = { 4004: "not_found", 4006: "not_found", 4111: "conflict", 4112: "conflict" };
