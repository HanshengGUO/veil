import { createHash } from "node:crypto";

/**
 * Select a logged, reproducible task seed from the task's calibrated seed bank.
 *
 * CI uses a label such as `smoke-v1`; an exact replay may use `seed:11`. Nothing uses ambient
 * randomness, and no run silently leaves the parameter range its calibration covered.
 */
export function selectTaskSeed(
  taskId: string,
  calibratedSeeds: readonly number[],
  variant: string,
): number {
  if (taskId.length === 0) throw new Error("task id must not be empty");
  if (variant.length === 0) throw new Error("variant label must not be empty");
  if (calibratedSeeds.length === 0) throw new Error("calibrated seed bank must not be empty");
  for (const seed of calibratedSeeds) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new Error("every calibrated seed must be an unsigned 32-bit integer");
    }
  }
  if (new Set(calibratedSeeds).size !== calibratedSeeds.length) {
    throw new Error("calibrated seeds must be unique");
  }

  if (variant.startsWith("seed:")) {
    const requested = Number(variant.slice("seed:".length));
    if (!calibratedSeeds.includes(requested)) {
      throw new Error(`requested seed ${String(requested)} is not in the calibrated seed bank`);
    }
    return requested;
  }

  const digest = createHash("sha256").update(taskId).update("\0").update(variant).digest();
  return calibratedSeeds[digest.readUInt32BE(0) % calibratedSeeds.length];
}
