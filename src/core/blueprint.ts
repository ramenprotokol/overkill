import { z } from "zod";
import { GRID_COLS, GRID_ROWS, MAX_PARTS } from "./constants.js";

const id = z.string().regex(/^[a-z][a-z0-9]{0,7}$/, "ids are short and lowercase, like b1, d3 or p2");
const col = z.number().int().min(0).max(GRID_COLS - 1);
const row = z.number().int().min(0).max(GRID_ROWS - 1);
const angle = z.union([
  z.literal(-60), z.literal(-45), z.literal(-30), z.literal(-15), z.literal(0),
  z.literal(15), z.literal(30), z.literal(45), z.literal(60),
]);

export const BallSchema = z.strictObject({ id, kind: z.literal("ball"), col, row, size: z.enum(["s", "m", "l"]) });
export const DominoSchema = z.strictObject({ id, kind: z.literal("domino"), col, row });
export const PlankSchema = z.strictObject({
  id, kind: z.literal("plank"), col, row,
  length: z.number().int().min(1).max(6),
  angle,
  fixed: z.boolean(),
});
export const SeesawSchema = z.strictObject({ id, kind: z.literal("seesaw"), col, row, length: z.number().int().min(2).max(6) });
export const BucketSchema = z.strictObject({ id, kind: z.literal("bucket"), col, row, fixed: z.boolean() });

export const PartSchema = z.discriminatedUnion("kind", [BallSchema, DominoSchema, PlankSchema, SeesawSchema, BucketSchema]);

export const FinaleSchema = z.strictObject({
  kind: z.enum(["switch", "bowl", "bell", "door", "plant"]),
  label: z.string().min(1).max(60),
  col,
  row,
});

export const FirstPushSchema = z.strictObject({
  ball: id,
  direction: z.enum(["left", "right"]),
  strength: z.enum(["soft", "medium", "hard"]),
});

export const BlueprintSchema = z.strictObject({
  note: z.string().max(140),
  finale: FinaleSchema,
  firstPush: FirstPushSchema,
  parts: z.array(PartSchema).min(1).max(MAX_PARTS),
});

/** Names the simulator uses for its own bodies; a part with one of these ids would be confused with them. */
const RESERVED_IDS = new Set(["finale", "floor"]);

export type Blueprint = z.infer<typeof BlueprintSchema>;
export type Part = z.infer<typeof PartSchema>;
export type ValidationResult = { ok: true; blueprint: Blueprint } | { ok: false; errors: string[] };

/** Schema check plus the rules a schema can't express (unique ids, what the first push hits). */
export function parseBlueprint(input: unknown): ValidationResult {
  const parsed = BlueprintSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "blueprint"}: ${i.message}`),
    };
  }
  const bp = parsed.data;
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const p of bp.parts) {
    if (seen.has(p.id)) errors.push(`parts: duplicate id "${p.id}"`);
    if (RESERVED_IDS.has(p.id)) errors.push(`parts: "${p.id}" is a reserved id`);
    seen.add(p.id);
  }
  const pushed = bp.parts.find((p) => p.id === bp.firstPush.ball);
  if (!pushed) errors.push(`firstPush.ball: no part with id "${bp.firstPush.ball}"`);
  else if (pushed.kind !== "ball") {
    errors.push(`firstPush.ball: "${pushed.id}" is a ${pushed.kind}; the first push must hit a ball`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, blueprint: bp };
}

/** JSON Schema for the tool definitions, generated from the zod schema so there is one source of truth. */
export function blueprintJsonSchema(): Record<string, unknown> {
  const { $schema: _unused, ...schema } = z.toJSONSchema(BlueprintSchema) as Record<string, unknown>;
  return schema;
}
