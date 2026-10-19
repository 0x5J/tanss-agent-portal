/**
 * How a booking text should read — in the user's own words, plus a handful of
 * their own texts as examples. A model imitates an example far better than it
 * follows a rule, so this is the cheapest way to make generated texts sound
 * like the ones already in TANSS.
 */
export type StyleSettings = {
  rules: string;
  examples: string[];
};

/**
 * Three, not more. Every example crowds out the actual material in the prompt,
 * and past three they stop teaching anything new.
 */
export const MAX_EXAMPLES = 3;
export const MAX_RULES_LENGTH = 1000;
export const MAX_EXAMPLE_LENGTH = 500;

export const DEFAULT_STYLE_RULES = [
  "Ein bis drei Sätze, sachlich und in der Vergangenheitsform.",
  "Was wurde getan und mit welchem Ergebnis — keine Floskeln, keine Anrede.",
  "Fachbegriffe bleiben stehen, Abkürzungen werden ausgeschrieben.",
  "Keine Zeitangaben im Text, die stehen im Feld Dauer.",
].join("\n");

export const DEFAULT_STYLE: StyleSettings = { rules: DEFAULT_STYLE_RULES, examples: [] };

/** The block that goes into every prompt writing a booking text. */
export function styleSection(style: StyleSettings): string {
  const rules = style.rules.trim() || DEFAULT_STYLE_RULES;
  const examples = style.examples.map((e) => e.trim()).filter(Boolean).slice(0, MAX_EXAMPLES);
  const parts = [`So soll eine Leistungsbeschreibung aussehen:\n${rules}`];
  if (examples.length) {
    parts.push(
      `Beispiele, die der Nutzer selbst als vorbildlich ausgewählt hat:\n${examples.map((e) => `- ${e}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function parseStyle(raw: unknown): StyleSettings {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rules = typeof obj.rules === "string" ? obj.rules.trim().slice(0, MAX_RULES_LENGTH) : "";
  const examples = (Array.isArray(obj.examples) ? obj.examples : [])
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().slice(0, MAX_EXAMPLE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_EXAMPLES);
  return { rules: rules || DEFAULT_STYLE_RULES, examples };
}
