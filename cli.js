#!/usr/bin/env node
require("tsx/cjs");
void require("./src/cli/index.ts").main(process.argv).catch((error) => {
  process.stderr.write(`PreFlight CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
