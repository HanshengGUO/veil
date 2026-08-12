import { NativeRuntimeError, probeNativeRuntime } from "./runtime-smoke.ts";

try {
  const report = await probeNativeRuntime();
  console.log(JSON.stringify({ ok: true, ...report }));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      stage: error instanceof NativeRuntimeError ? error.stage : "unknown",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
