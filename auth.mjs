import { Buffer } from "node:buffer"
import { DeepSeekClient } from "./client.mjs"

/**
 * Normalizes user token from various input formats (raw string, Bearer prefix, JSON from localStorage).
 */
export function normalizeUserToken(input) {
  if (!input) return ""
  let text = String(input).trim()

  // Remove surrounding quotes if present
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim()
  }

  // Remove Bearer prefix
  if (text.toLowerCase().startsWith("bearer ")) {
    text = text.slice(7).trim()
  }

  // Check if it is a JSON dump from localStorage: {"value": "...", "__version": "0"}
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text)
      if (parsed.value && typeof parsed.value === "string") {
        text = parsed.value.trim()
      } else if (parsed.token && typeof parsed.token === "string") {
        text = parsed.token.trim()
      } else if (parsed.userToken && typeof parsed.userToken === "string") {
        text = parsed.userToken.trim()
      }
    } catch {}
  }

  return text
}

/**
 * Extracts payload claims from JWT token if available.
 */
export function decodeJwtClaims(token) {
  try {
    const parts = token.split(".")
    if (parts.length >= 2) {
      const payload = Buffer.from(parts[1], "base64url").toString("utf8")
      return JSON.parse(payload)
    }
  } catch {}
  return null
}

/**
 * Validates a userToken by making a quick zero-side-effect test request to create_pow_challenge.
 */
export async function validateToken(token) {
  const normalized = normalizeUserToken(token)
  if (!normalized) {
    return { ok: false, error: "Token is empty" }
  }

  try {
    const client = new DeepSeekClient(normalized)
    await client.createPowChallenge("/api/v0/chat/completion")
    const claims = decodeJwtClaims(normalized)
    return {
      ok: true,
      userId: claims?.sub || claims?.uid || "deepseek-user",
      email: claims?.email || "",
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
    }
  }
}
