import { createHmac } from "node:crypto";

export type TotpConfig = {
  secret: Buffer;
  digits: number;
  /** Length of one time step in seconds. */
  period: number;
  algorithm: "sha1" | "sha256" | "sha512";
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32 without padding. Spaces and dashes are tolerated because
 * that is how token seeds are usually written down.
 */
export function decodeBase32(raw: string): Buffer {
  const clean = raw.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean) {
    throw new Error("Das TOTP-Geheimnis ist leer");
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index === -1) {
      throw new Error(`Das TOTP-Geheimnis enthält ein ungültiges Zeichen: ${character}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) {
    throw new Error("Das TOTP-Geheimnis ist zu kurz");
  }
  return Buffer.from(bytes);
}

/**
 * Accepts either a bare base32 seed or the whole `otpauth://totp/...` URI that
 * a token's QR code carries, so the value can be pasted as it was received.
 */
export function parseTotpConfig(raw: string): TotpConfig {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("otpauth://")) {
    return {
      secret: decodeBase32(trimmed),
      digits: 6,
      period: 30,
      algorithm: "sha1",
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("TOTP_SECRET ist keine gültige otpauth-URI");
  }
  if (url.host.toLowerCase() !== "totp") {
    throw new Error("TOTP_SECRET muss eine otpauth://totp/-URI sein, nicht hotp");
  }

  const secret = url.searchParams.get("secret");
  if (!secret) {
    throw new Error("Der otpauth-URI fehlt der Parameter secret");
  }
  return {
    secret: decodeBase32(secret),
    digits: readNumber(url.searchParams.get("digits"), 6, [6, 7, 8], "digits"),
    period: readNumber(url.searchParams.get("period"), 30, [30, 60], "period"),
    algorithm: readAlgorithm(url.searchParams.get("algorithm")),
  };
}

function readNumber(
  raw: string | null,
  fallback: number,
  allowed: number[],
  name: string,
): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!allowed.includes(value)) {
    throw new Error(`TOTP-Parameter ${name} ist ungültig: ${raw}`);
  }
  return value;
}

function readAlgorithm(raw: string | null): TotpConfig["algorithm"] {
  const value = (raw ?? "SHA1").toUpperCase();
  if (value === "SHA1") return "sha1";
  if (value === "SHA256") return "sha256";
  if (value === "SHA512") return "sha512";
  throw new Error(`TOTP-Algorithmus wird nicht unterstützt: ${raw}`);
}

/** The code for the time step that contains `nowMs` (RFC 6238). */
export function generateTotp(config: TotpConfig, nowMs: number): string {
  const counter = Math.floor(nowMs / 1000 / config.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(config.algorithm, config.secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** config.digits).padStart(config.digits, "0");
}

/** Seconds left before the current code rolls over. */
export function secondsUntilNextCode(config: TotpConfig, nowMs: number): number {
  const seconds = Math.floor(nowMs / 1000);
  return config.period - (seconds % config.period);
}
