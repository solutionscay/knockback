/**
 * Engine version: which physics and controller behavior made a match record.
 *
 * Rule: bump ENGINE_VERSION in the same commit as any change that changes sim hashes (physics, level generation,
 * controllers, combat). Every new record stamps the version that made it (`engine`). The app loads only records of
 * this version: that is the one check (isCurrentEngine). A record of any other version is not loaded.
 *
 * The field is not part of any hash: it lives in the record, not in the sim state.
 */
export const ENGINE_VERSION = 6;

/** The one check: true when a record was made by this engine version. */
export function isCurrentEngine(rec: unknown): boolean {
  return !!rec && typeof rec === "object" && (rec as { engine?: unknown }).engine === ENGINE_VERSION;
}

/** A record of another engine version: not loaded. */
export class OtherEngineError extends Error {
  constructor(readonly engine: unknown) {
    super(`this record was made by engine ${JSON.stringify(engine ?? null)}; this is engine v${ENGINE_VERSION}: only records of the current engine are loaded`);
  }
}

/** Throw OtherEngineError unless the record is of the current engine version. */
export function checkRecordEngine(rec: unknown): void {
  if (!isCurrentEngine(rec)) throw new OtherEngineError(rec && typeof rec === "object" ? (rec as { engine?: unknown }).engine : undefined);
}
