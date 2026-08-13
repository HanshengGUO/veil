/**
 * Minimal veil-node factor. The runtime has already decoded guarded Arrow IPC into `table`.
 * Replace the example score with the registered deterministic factor; do not read data or paths.
 * Immutable parameters are in context.paramsLocked and context.declaredLiterals. Keep rowIndices
 * in source-table order; derived values may be null when a source row has no signal.
 */
export function compute(table, context) {
  void context;
  const close = table.getChild("close");
  if (close === null) throw new Error("factor input is missing close");

  const rowIndices = Array.from({ length: table.numRows }, (_, row) => row);
  return {
    rowIndices,
    columns: {
      factor_score: rowIndices.map((row) => {
        const value = close.get(row);
        return value === null ? null : Number(value);
      }),
    },
  };
}
