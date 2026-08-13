export function compute(table, context) {
  if (context.paramsLocked.lookback_days !== 3) {
    throw new Error("locked lookback changed before verification");
  }
  const price = table.getChild("price");
  if (price === null) throw new Error("verification view is missing price");
  const rowIndices = Array.from({ length: table.numRows }, (_, index) => index);
  return {
    rowIndices,
    columns: { toy_score: rowIndices.map((row) => Number(price.get(row))) },
  };
}
