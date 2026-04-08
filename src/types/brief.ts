import { z } from "zod";

export const BriefSchema = z.object({
  target: z.string().min(1),
  scope: z.string().min(1),
  code: z.array(z.string()).optional(),
  links: z.array(z.string().url()).optional(),
  context: z.string().optional(),
  goal: z.string().min(1),
});

export type Brief = z.infer<typeof BriefSchema>;

/** Parse a markdown brief file into a structured Brief. */
export function parseBrief(raw: string): Brief {
  const fields: Record<string, string> = {};
  const listFields: Record<string, string[]> = {};

  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Z_]+):\s*(.+)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (!key || !value) continue;

    if (key === "CODE" || key === "LINKS") {
      listFields[key.toLowerCase()] = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      fields[key.toLowerCase()] = value.trim();
    }
  }

  return BriefSchema.parse({
    target: fields["target"],
    scope: fields["scope"],
    code: listFields["code"],
    links: listFields["links"],
    context: fields["context"],
    goal: fields["goal"],
  });
}
