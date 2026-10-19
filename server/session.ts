import type { IncomingMessage, ServerResponse } from "node:http";
import { getIronSession, type SessionOptions } from "iron-session";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { TanssSession } from "./tanss.ts";

export type SessionData = Partial<TanssSession> & {
  /** The store's session generation at login; a logout moves past it. */
  generation?: number;
};

export function sessionOptions(password: string): SessionOptions {
  return {
    cookieName: "agent_portal",
    password,
    ttl: 60 * 60 * 24 * 5,
    cookieOptions: {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
    },
  };
}

export async function readSession(
  request: FastifyRequest,
  reply: FastifyReply,
  password: string,
) {
  return getIronSession<SessionData>(
    request.raw as IncomingMessage,
    reply.raw as ServerResponse,
    sessionOptions(password),
  );
}

export function requireSession(data: SessionData): TanssSession {
  if (!data.apiKey || !data.refresh || !data.employeeId) {
    const error = new Error("Nicht angemeldet");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
  return {
    employeeId: data.employeeId,
    apiKey: data.apiKey,
    refresh: data.refresh,
    expire: data.expire ?? 0,
  };
}

/**
 * Who the cookie says you are. The tokens themselves live server-side in the
 * shared session — a cookie from before that change still carries them, and
 * its employeeId is just as good.
 */
export function requireEmployee(data: SessionData): number {
  if (!data.employeeId) {
    const error = new Error("Nicht angemeldet");
    (error as Error & { statusCode: number }).statusCode = 401;
    throw error;
  }
  return data.employeeId;
}
