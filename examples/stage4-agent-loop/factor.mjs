export function compute(table) {
  const price = table.getChild("price");
  if (price === null) throw new Error("verification view is missing price");
  const rowIndices = Array.from({ length: table.numRows }, (_, index) => index);
  return {
    rowIndices,
    columns: { score: rowIndices.map((row) => Number(price.get(row))) },
  };
}
