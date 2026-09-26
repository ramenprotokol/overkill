import type { PreviewResult } from "../core/preview.js";
import type { AttemptReport } from "../core/trace.js";

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

export function formatReport(attempt: number, maxAttempts: number, r: AttemptReport): string {
  const lines = [`Attempt ${attempt} of ${maxAttempts}: ${r.outcome.toUpperCase().replace("_", " ")}`, r.summary];
  if (r.neverMoved.length > 0) lines.push(`Never moved: ${r.neverMoved.join(", ")}.`);
  if (r.fellOff.length > 0) lines.push(`Fell off the board: ${r.fellOff.join(", ")}.`);
  if (!r.success) lines.push(`Attempts left: ${maxAttempts - attempt}.`);
  return lines.join("\n");
}

export function formatInvalid(attempt: number, maxAttempts: number, errors: string[]): string {
  return [`Attempt ${attempt} of ${maxAttempts}: INVALID blueprint (the attempt is used).`, bullets(errors), `Attempts left: ${maxAttempts - attempt}.`].join("\n");
}

export function formatPreview(p: PreviewResult): string {
  const lines = ["Preview (no attempt used)."];
  lines.push(p.errors.length > 0 ? `Errors:\n${bullets(p.errors)}` : "Errors: none.");
  if (p.warnings.length > 0) lines.push(`Warnings:\n${bullets(p.warnings)}`);
  if (p.board) lines.push(`Board:\n${p.board}`);
  return lines.join("\n");
}
