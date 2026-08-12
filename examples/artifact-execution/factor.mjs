export function compute(arrowIpc, context) {
  if (context.paramsLocked.lookbackDays !== 20) {
    throw new Error("locked parameter changed before factor execution");
  }
  return arrowIpc;
}
