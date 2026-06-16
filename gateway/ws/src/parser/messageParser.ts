import {
  joinGameSchema,
  playerActionSchema,
  leaveGameSchema,
  pingSchema,
  type JoinGameMessage,
  type PlayerActionMessage,
  type LeaveGameMessage,
  type PingMessage,
} from "./schemas.js";

// ─── Discriminated union of parsed messages ───────────────────────────────────

export type ParsedMessage =
  | { type: "JOIN_GAME"; data: JoinGameMessage }
  | { type: "PLAYER_ACTION"; data: PlayerActionMessage }
  | { type: "LEAVE_GAME"; data: LeaveGameMessage }
  | { type: "PING"; data: PingMessage }
  | { type: "PARSE_ERROR"; code: "INVALID_MESSAGE" | "PROTOCOL_VERSION_MISMATCH"; message: string };

/**
 * Parses and validates an incoming WebSocket message.
 *
 * Returns a discriminated union — callers switch on `.type`.
 * Never throws.
 */
export function parseMessage(rawData: unknown): ParsedMessage {
  // 1. Deserialize JSON
  let json: unknown;
  try {
    json = JSON.parse(String(rawData));
  } catch {
    return {
      type: "PARSE_ERROR",
      code: "INVALID_MESSAGE",
      message: "Payload is not valid JSON",
    };
  }

  // 2. Must be a plain object
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return {
      type: "PARSE_ERROR",
      code: "INVALID_MESSAGE",
      message: "Message must be a JSON object",
    };
  }

  const obj = json as Record<string, unknown>;

  // 3. Protocol version guard — checked BEFORE schema validation
  if (obj["v"] !== "1") {
    return {
      type: "PARSE_ERROR",
      code: "PROTOCOL_VERSION_MISMATCH",
      message: `Unsupported protocol version "${String(obj["v"])}". Expected "1"`,
    };
  }

  // 4. Dispatch by event type
  const event = obj["event"];

  switch (event) {
    case "JOIN_GAME": {
      const result = joinGameSchema.safeParse(json);
      if (!result.success) {
        return { type: "PARSE_ERROR", code: "INVALID_MESSAGE", message: result.error.message };
      }
      return { type: "JOIN_GAME", data: result.data };
    }

    case "PLAYER_ACTION": {
      const result = playerActionSchema.safeParse(json);
      if (!result.success) {
        return { type: "PARSE_ERROR", code: "INVALID_MESSAGE", message: result.error.message };
      }
      return { type: "PLAYER_ACTION", data: result.data };
    }

    case "LEAVE_GAME": {
      const result = leaveGameSchema.safeParse(json);
      if (!result.success) {
        return { type: "PARSE_ERROR", code: "INVALID_MESSAGE", message: result.error.message };
      }
      return { type: "LEAVE_GAME", data: result.data };
    }

    case "PING": {
      const result = pingSchema.safeParse(json);
      if (!result.success) {
        return { type: "PARSE_ERROR", code: "INVALID_MESSAGE", message: result.error.message };
      }
      return { type: "PING", data: result.data };
    }

    default:
      return {
        type: "PARSE_ERROR",
        code: "INVALID_MESSAGE",
        message: `Unknown event type: "${String(event)}"`,
      };
  }
}
