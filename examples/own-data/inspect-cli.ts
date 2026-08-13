import {
  describeOwnDataInspectionError,
  inspectOwnData,
  OWN_DATA_INSPECTION_HELP,
  parseOwnDataInspectionArguments,
} from "./inspect.ts";

if (process.argv.includes("--help")) {
  process.stdout.write(`${OWN_DATA_INSPECTION_HELP}\n`);
} else {
  try {
    const report = await inspectOwnData(parseOwnDataInspectionArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(describeOwnDataInspectionError(error), null, 2)}\n`);
    process.exitCode = 1;
  }
}
