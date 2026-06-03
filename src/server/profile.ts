import { z } from "zod";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// ─── profile: the loadable categorization schema ────────────────────────
// A profile declares the net-worth blocks, the Plaid-subtype→block mapping,
// and (optionally) a starter line-code catalog. It is the single source of
// truth for "how money is categorized" so a personal setup and a generic
// open-source setup are just two files. Select one with LEDGER_PROFILE
// (defaults to "default"); a gitignored "local" profile holds private setups.

export const RENDER_KINDS = ["generic", "mortgage", "auto", "credit", "realEstate"] as const;

const BlockSchema = z.object({
  id: z.string().min(1).max(64),          // stable slug — the key accounts reference
  name: z.string().min(1).max(40),        // display label (editable, never the key)
  kind: z.enum(["asset", "liability"]),
  order: z.number().int(),
  render: z.enum(RENDER_KINDS).optional(), // UI hint for bespoke cells; default generic
  investment: z.boolean().optional(),      // true = keep its activity out of the spend feed
});

const LineCodeSchema = z.object({
  code: z.string().min(1),
  category: z.string().min(1),
  categoryCode: z.number().int(),
  label: z.string().min(1),
  ytd2025: z.number().optional(),
  spending: z.boolean().optional(), // false = income/transfer, excluded from spend net
});

export const ProfileSchema = z.object({
  name: z.string().default("default"),
  blocks: z.array(BlockSchema),
  subtypeMap: z.record(z.string(), z.string()), // plaid subtype substring → block id
  lineCodes: z.array(LineCodeSchema).optional(),
}).superRefine((p, ctx) => {
  // Every subtypeMap target and every block id must be internally consistent.
  const ids = new Set(p.blocks.map((b) => b.id));
  if (ids.size !== p.blocks.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate block id" });
  }
  for (const [subtype, target] of Object.entries(p.subtypeMap)) {
    if (!ids.has(target)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `subtypeMap["${subtype}"] → unknown block id "${target}"` });
    }
  }
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Block = z.infer<typeof BlockSchema>;

const PROFILE_DIR = join(import.meta.dir, "../../profiles");

let _profile: Profile | null = null;

/** Load + validate the active profile (LEDGER_PROFILE, else "default"). Cached. */
export function getProfile(): Profile {
  if (_profile) return _profile;
  const requested = process.env.LEDGER_PROFILE || "default";
  const path = join(PROFILE_DIR, `${requested}.json`);
  const fallback = join(PROFILE_DIR, "default.json");
  const chosen = existsSync(path) ? path : fallback;
  if (chosen !== path) {
    console.warn(`[profile] "${requested}.json" not found, using default.json`);
  }
  const raw = JSON.parse(readFileSync(chosen, "utf-8"));
  _profile = ProfileSchema.parse(raw);
  return _profile;
}

/** For tests: drop the cache so a different LEDGER_PROFILE takes effect. */
export function resetProfileCache(): void {
  _profile = null;
}

/** Stable, URL-safe key derived from a display name. */
export function slug(name: string): string {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
