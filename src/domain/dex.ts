export interface DexClassifier {
  /** True for bonding-curve "pools" (pre-graduation launches). */
  isBondingCurve(dexId: string | null): boolean;
  /** Launchpad an AMM pool graduated from, when known by construction (e.g. pumpswap -> pump.fun). */
  launchpadFor(dexId: string | null): string | null;
}

export function createDexClassifier(
  bondingCurveDexIds: readonly string[],
  ammLaunchpadByDexId: Record<string, string>,
): DexClassifier {
  const bonding = new Set(bondingCurveDexIds.map((d) => d.toLowerCase()));
  return {
    isBondingCurve: (dexId) => dexId !== null && bonding.has(dexId.toLowerCase()),
    launchpadFor: (dexId) => (dexId ? (ammLaunchpadByDexId[dexId.toLowerCase()] ?? null) : null),
  };
}
