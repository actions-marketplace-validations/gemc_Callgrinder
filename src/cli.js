#!/usr/bin/env node

// Local entry point (the `callgrinder` bin): profile one command and print the summary section, or
// report from a directory of partial JSON files.

const fs = require("node:fs");
const path = require("node:path");
const { profile, summarizeCallgrind } = require("./profile");
const { createReport } = require("./report");

const USAGE = `Usage:
  callgrinder <command> [options]              Profile a command under callgrind and print its summary.
  callgrinder --from-callgrind FILE [options]  Summarize an existing callgrind.out file (no run).
  callgrinder report [options]                 Aggregate partial JSON files into summary.md + CSV.

Options:
  --from-callgrind FILE    Summarize this existing callgrind file instead of running a command.
  --program NAME           Program to keep when the command runs several processes (default: the largest).
  --name NAME              Profile name (default: profile).
  --events N               Value for the {events} placeholder (default: 0).
  --config FILE            JSON category config (see README).
  --output-dir DIR         Output directory (default: callgrinder).
  --input-dir DIR          Partial-JSON directory for report mode (default: callgrinder-parts).
  --working-directory DIR  Directory in which the command runs (default: .).
  --timeout-seconds N      Per-command timeout; 0 disables (default: 0).
  --callgrind-args "ARGS"  Extra flags appended to the callgrind invocation.
  -h, --help               Show this help.

The command may contain {events}, {name}, and {run} placeholders. Quote it as a single argument;
quote inner arguments that contain spaces, e.g.:
  callgrinder 'gemc card.yaml -n {events} -gsystem="[{name: det, factory: ascii}]"' --name det --events 100
`;

function parseArgs(argv) {
  const options = { command: null, mode: "profile" };
  const map = {
    "--from-callgrind": "fromCallgrind",
    "--program": "program",
    "--name": "name",
    "--events": "events",
    "--config": "config",
    "--output-dir": "outputDirectory",
    "--input-dir": "inputDirectory",
    "--working-directory": "workingDirectory",
    "--timeout-seconds": "timeoutSeconds",
    "--callgrind-args": "callgrindArgs",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (argument === "report") {
      options.mode = "report";
    } else if (map[argument]) {
      options[map[argument]] = argv[index + 1];
      index += 1;
    } else if (!argument.startsWith("--") && options.command === null && options.mode === "profile") {
      options.command = argument;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "report") {
    const result = createReport({
      inputDirectory: options.inputDirectory || "callgrinder-parts",
      outputDirectory: options.outputDirectory || "callgrinder",
    });
    process.stdout.write(`${fs.readFileSync(result.summaryFile, "utf8")}\n`);
    process.stderr.write(`Wrote ${result.summaryFile}, ${result.csvFile}\n`);
    return;
  }
  if (options.fromCallgrind) {
    const summarized = summarizeCallgrind({
      name: options.name || "profile",
      callgrindFile: options.fromCallgrind,
      config: options.config,
      events: options.events || "0",
      command: options.command || "",
      outputDirectory: options.outputDirectory || "callgrinder",
    });
    process.stdout.write(`${summarized.markdown}\n`);
    process.stderr.write(`Wrote ${summarized.partialFile}\n`);
    return;
  }
  if (!options.command) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const result = profile({
    name: options.name || "profile",
    command: options.command,
    events: options.events || "0",
    config: options.config,
    callgrindArgs: options.callgrindArgs ? options.callgrindArgs.split(/\s+/).filter(Boolean) : [],
    outputDirectory: options.outputDirectory || "callgrinder",
    workingDirectory: path.resolve(options.workingDirectory || process.cwd()),
    timeoutSeconds: options.timeoutSeconds ? Number(options.timeoutSeconds) : 0,
    program: options.program || "",
  });
  process.stdout.write(`${result.markdown}\n`);
  process.stderr.write(`Wrote ${result.partialFile} and ${result.callgrindFile}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
