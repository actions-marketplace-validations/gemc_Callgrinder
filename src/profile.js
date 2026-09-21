// Profile mode: run a command under callgrind, parse both passes, render the section.

const fs = require("node:fs");
const path = require("node:path");
const { annotate, parseAnnotate, runCallgrind } = require("./callgrind");
const { loadConfig } = require("./categories");
const { renderProfile } = require("./report");
const { ensureDirectory, slugify } = require("./utils");

// Fill {events}, {name}, {run} placeholders in a command template.
function expandCommand(command, { events, name, run }) {
  return command
    .replace(/\{events\}/g, String(events))
    .replace(/\{name\}/g, String(name))
    .replace(/\{run\}/g, String(run));
}

function profile({
  name,
  command,
  events = 0,
  run = 1,
  config: configSource,
  callgrindArgs = [],
  outputDirectory = "callgrinder",
  workingDirectory = ".",
  timeoutSeconds = 0,
}) {
  const config = loadConfig(configSource);
  const slug = slugify(name);
  ensureDirectory(outputDirectory);
  const callgrindFile = path.resolve(outputDirectory, `callgrind.out.${slug}`);
  const expanded = expandCommand(command, { events, name, run });

  runCallgrind({
    command: expanded,
    outFile: callgrindFile,
    extraArgs: callgrindArgs,
    workingDirectory,
    timeoutSeconds,
  });

  const inclusive = parseAnnotate(annotate(callgrindFile, { inclusive: true }));
  let selfRows = [];
  let topNote = "";
  try {
    selfRows = parseAnnotate(annotate(callgrindFile, { inclusive: false })).rows;
  } catch (error) {
    topNote = `\n_Self-cost pass unavailable: ${error.message}_\n`;
  }

  const rendered = renderProfile({
    title: name,
    config,
    inclTotal: inclusive.total,
    inclRows: inclusive.rows,
    selfRows,
  });

  const partial = {
    name,
    slug,
    command: expanded,
    events,
    cost: config.cost || "CEst",
    callgrind_file: path.basename(callgrindFile),
    markdown: rendered.markdown + topNote,
    ...rendered.structured,
  };
  const partialFile = path.resolve(outputDirectory, `profile-${slug}.json`);
  fs.writeFileSync(partialFile, `${JSON.stringify(partial, null, 2)}\n`, "utf8");

  return { partial, partialFile, callgrindFile, markdown: rendered.markdown + topNote };
}

module.exports = { expandCommand, profile };
