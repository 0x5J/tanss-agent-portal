import { z } from "zod";

export const loginInputSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  /** Left out when the server generates the code from a configured token seed. */
  token: z.string().trim().min(1).optional(),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

export type LoginFormResult =
  | { ok: true; value: LoginInput }
  | { ok: false; error: string };

/**
 * Form-level check. When the server has a token seed the field is not shown, so
 * an empty token is fine; otherwise it is required like the other two.
 */
export function validateLoginForm(
  raw: { username: string; password: string; token: string },
  opts: { tokenRequired: boolean },
): LoginFormResult {
  const parsed = loginInputSchema.safeParse({
    username: raw.username,
    password: raw.password,
    token: raw.token.trim() ? raw.token : undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: opts.tokenRequired
        ? "Benutzername, Passwort und 2FA-Token sind erforderlich"
        : "Benutzername und Passwort sind erforderlich",
    };
  }
  if (opts.tokenRequired && !parsed.data.token) {
    return { ok: false, error: "Benutzername, Passwort und 2FA-Token sind erforderlich" };
  }
  return { ok: true, value: parsed.data };
}
