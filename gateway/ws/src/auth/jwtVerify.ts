import { jwtVerify, SignJWT } from "jose";
import type { FastifyRequest } from "fastify";

// HS256 secret — minimum 32 bytes for security.
// In production, load from environment: JWT_SECRET must be a long random string.
const JWT_SECRET_RAW = process.env["JWT_SECRET"] ?? "dev-secret-for-testing-CHANGE-IN-PROD!!";
const SECRET_BYTES = new TextEncoder().encode(JWT_SECRET_RAW);

export interface JwtPayload {
  sub: string;      // playerId
  username?: string; // display name (optional, falls back to playerId)
  exp?: number;
  iat?: number;
}

/**
 * Verifies a JWT token signed with HS256.
 * Returns the payload on success, or `null` if the token is invalid/expired.
 */
export async function verifyJwt(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET_BYTES, {
      algorithms: ["HS256"],
    });
    if (typeof payload["sub"] !== "string" || !payload["sub"]) return null;
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Extracts the Bearer token from an `Authorization` header
 * or from the `?token=` query parameter (browser WebSocket fallback —
 * browsers cannot set custom headers during WS Upgrade).
 * Returns `null` if neither is present or malformed.
 */
export function extractBearerToken(request: FastifyRequest): string | null {
  // 1. Standard Authorization header (Node.js clients, tests)
  const auth = request.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token.length > 0) return token;
  }

  // 2. Query parameter fallback for browser WebSocket clients
  const qToken = (request.query as Record<string, unknown>)["token"];
  if (typeof qToken === "string" && qToken.length > 0) return qToken;

  return null;
}

/**
 * Development helper — creates a signed JWT for testing.
 * Not used in production flow.
 */
export async function signTestJwt(playerId: string, expiresIn = "1h"): Promise<string> {
  return new SignJWT({ sub: playerId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(SECRET_BYTES);
}
