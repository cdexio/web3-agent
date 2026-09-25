import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const walletSchema = z.object({
  address: z.string().min(32).max(44),
  label: z.string().optional(),
  source: z.string().optional(),
  addedAt: z.string().optional(),
});

const fileSchema = z.object({
  $comment: z.string().optional(),
  wallets: z.array(walletSchema),
});

export interface KolWallet {
  address: string;
  label: string | null;
  source: string | null;
  addedAt: string | null;
}

/** Owner-maintained GMGN wallet list (`config/kol-wallets.json`, git-ignored). Missing file = no wallets. */
export function loadKolWallets(file: string, maxWallets: number): KolWallet[] {
  if (!existsSync(file)) return [];
  const parsed = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const seen = new Set<string>();
  const out: KolWallet[] = [];
  for (const w of parsed.wallets) {
    if (w.address.startsWith("REPLACE") || seen.has(w.address)) continue;
    seen.add(w.address);
    out.push({
      address: w.address,
      label: w.label ?? null,
      source: w.source ?? null,
      addedAt: w.addedAt ?? null,
    });
    if (out.length >= maxWallets) break;
  }
  return out;
}
