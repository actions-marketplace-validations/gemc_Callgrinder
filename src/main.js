#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { buildMatrix, parseBenchmarks } = require("./matrix");
const { profile, summarizeCallgrind } = require("./profile");
const { createReport } = require("./report");
const { appendSummary, getInput, getIntegerInput, setOutput } = require("./utils");

function discover() {
  const benchmarks = parseBenchmarks(getInput("benchmarks"));
  const matrix = buildMatrix(benchmarks);
  setOutput("matrix", matrix);
  setOutput("job-count", matrix.include.length);
  appendSummary(`## Callgrinder discovery\n\nGenerated ${matrix.include.length} profile jobs.\n`);
}

function runProfile() {
  const outputDirectory = getInput("output-dir", "callgrinder");
  const fromCallgrind = getInput("from-callgrind");
  let result;
  if (fromCallgrind) {
    // Summarize a callgrind file the caller produced (e.g. GEMC runs valgrind its own way).
    result = summarizeCallgrind({
      name: getInput("name", "profile"),
      callgrindFile: fromCallgrind,
      config: getInput("config"),
      events: getInput("events", "0"),
      command: getInput("command"),
      outputDirectory,
    });
  } else {
    const callgrindArgs = getInput("callgrind-args");
    result = profile({
      name: getInput("name", "profile"),
      command: getInput("command"),
      events: getInput("events", "0"),
      run: getIntegerInput("run", 1, 1),
      config: getInput("config"),
      callgrindArgs: callgrindArgs ? callgrindArgs.split(/\s+/).filter(Boolean) : [],
      outputDirectory,
      workingDirectory: path.resolve(getInput("working-directory", process.cwd())),
      timeoutSeconds: getIntegerInput("timeout-seconds", 0),
    });
  }
  setOutput("results-dir", path.resolve(outputDirectory));
  setOutput("callgrind-file", result.callgrindFile);
  setOutput("result-file", result.partialFile);
  appendSummary(result.markdown);
}

function report() {
  const outputDirectory = getInput("output-dir", "callgrinder");
  const result = createReport({
    inputDirectory: getInput("input-dir", "callgrinder-parts"),
    outputDirectory,
  });
  setOutput("results-dir", path.resolve(outputDirectory));
  setOutput("summary-file", path.resolve(result.summaryFile));
  setOutput("csv-file", path.resolve(result.csvFile));
  setOutput("json-file", path.resolve(result.jsonFile));
  appendSummary(fs.readFileSync(result.summaryFile, "utf8"));
}

function main() {
  const mode = getInput("mode", "profile").toLowerCase();
  if (mode === "discover") {
    discover();
  } else if (mode === "profile") {
    runProfile();
  } else if (mode === "report") {
    report();
  } else {
    throw new Error(`mode must be discover, profile, or report; received ${mode}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`::error::${error.stack || error.message}`);
  process.exitCode = 1;
}
