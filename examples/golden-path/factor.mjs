/**
 * Produces the four pre-registered momentum candidates for the current decision only.
 * The verification view has already removed ineligible rows, so this code never owns the mask.
 * Pricing and per-fold candidate selection remain outside the Stage 2 structural contract.
 */
export function compute(table, context) {
  const lookbacks = context.paramsLocked.candidateLookbacks;
  if (
    !Array.isArray(lookbacks) ||
    lookbacks.join(",") !== "3,5,10,20" ||
    context.paramsLocked.standardization !== "expanding" ||
    context.paramsLocked.selectionScope !== "training-fold-only" ||
    context.declaredLiterals.minimumHistory !== 20
  ) {
    throw new Error("golden-path parameter lock changed before contract execution");
  }

  const entity = table.getChild("ticker");
  const eventTime = table.getChild("date");
  const close = table.getChild("close");
  if (entity === null || eventTime === null || close === null) {
    throw new Error("golden-path verification view is missing factor columns");
  }

  const decisionMillis = Date.parse(context.decisionTime);
  const stateByEntity = new Map();
  const rowIndices = [];
  const scoreValues = lookbacks.map(() => []);

  for (let row = 0; row < table.numRows; row += 1) {
    const key = entityKey(entity.get(row));
    const instant = timeMillis(eventTime.get(row));
    const price = Number(close.get(row));
    if (!Number.isFinite(price) || price <= 0) continue;
    let state = stateByEntity.get(key);
    if (state === undefined) {
      state = {
        closes: [],
        counts: new Float64Array(lookbacks.length),
        sums: new Float64Array(lookbacks.length),
        squares: new Float64Array(lookbacks.length),
      };
      stateByEntity.set(key, state);
    }

    const isDecisionRow = instant === decisionMillis;
    for (let index = 0; index < lookbacks.length; index += 1) {
      const lookback = lookbacks[index];
      const past = state.closes[state.closes.length - lookback];
      let score = Number.NaN;
      if (Number.isFinite(past) && past > 0) {
        const raw = price / past - 1;
        state.counts[index] += 1;
        state.sums[index] += raw;
        state.squares[index] += raw * raw;
        if (state.counts[index] >= context.declaredLiterals.minimumHistory) {
          const mean = state.sums[index] / state.counts[index];
          const variance = state.squares[index] / state.counts[index] - mean * mean;
          if (variance > 0) score = (raw - mean) / Math.sqrt(variance);
        }
      }
      if (isDecisionRow) scoreValues[index].push(score);
    }
    state.closes.push(price);

    if (isDecisionRow) rowIndices.push(row);
  }

  const scores = Object.fromEntries(
    lookbacks.map((lookback, index) => [`momentum_${lookback}`, scoreValues[index]]),
  );
  return { rowIndices, scores };
}

function timeMillis(value) {
  const instant = value instanceof Date ? value.valueOf() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error("golden-path factor received an invalid event time");
  return instant;
}

function entityKey(value) {
  if (typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("golden-path factor received an invalid entity key");
}
