import { assertPiRuntime } from "./model.ts";

assertPiRuntime();
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const runtime = await ModelRuntime.create({ refreshOnCreate: false });
const provider = process.argv[2];
for (const model of runtime.getModels(provider)) {
  process.stdout.write(`${model.provider}/${model.id}\n`);
}
