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

// Annotate an existing callgrind file (both passes), render the section, and write the partial JSON.
// Shared by `profile` (after it runs valgrind) and the `--from-callgrind` path, which lets a caller run
// valgrind its own way and hand Callgrinder the resulting profile.
// Diagnostic section when callgrind_annotate cannot produce a summary, keeping the callgrind file's
// size visible (an empty/tiny file means the profiled program produced no event data).
function unavailableSection(name, callgrindFile, size, notes) {
  const hint =
    size < 1024
      ? `The callgrind file is ${size} bytes — callgrind_annotate found no event data, so the profiled ` +
        "command likely did not run to completion under callgrind. The raw file is attached for inspection."
      : "The raw callgrind file is attached; open it with qcachegrind or run callgrind_annotate manually.";
  return [
    `### ${name}`,
    "",
    `_Profile summary unavailable for \`${path.basename(callgrindFile)}\` (${size} bytes)._`,
    "",
    "<details><summary>diagnostics</summary>",
    "",
    "```",
    ...notes,
    hint,
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
}

function summarizeCallgrind({
  name,
  callgrindFile,
  config: configSource,
  events = 0,
  command = "",
  outputDirectory = "callgrinder",
}) {
  const config = loadConfig(configSource);
  const slug = slugify(name);
  ensureDirectory(outputDirectory);

  let size = 0;
  try {
    size = fs.statSync(callgrindFile).size;
  } catch {
    size = 0;
  }

  // Each pass is best effort: a broken --inclusive pass should not sink the self-cost table, and a
  // completely unreadable file should produce a visible diagnostic, not crash the action.
  const notes = [];
  let inclusive = null;
  try {
    inclusive = parseAnnotate(annotate(callgrindFile, { inclusive: true }));
  } catch (error) {
    notes.push(`Category table unavailable (callgrind_annotate --inclusive): ${error.message}`);
  }
  let selfRows = [];
  try {
    selfRows = parseAnnotate(annotate(callgrindFile, { inclusive: false })).rows;
  } catch (error) {
    notes.push(`Top-routines table unavailable (callgrind_annotate): ${error.message}`);
  }

  let markdown;
  let structured = { total: {}, categories: [], top_routines: [] };
  if (inclusive) {
    const rendered = renderProfile({
      title: name,
      config,
      inclTotal: inclusive.total,
      inclRows: inclusive.rows,
      selfRows,
    });
    markdown = rendered.markdown;
    structured = rendered.structured;
    if (notes.length > 0) {
      markdown += `\n${notes.map((note) => `_${note}_`).join("\n\n")}\n`;
    }
  } else {
    markdown = unavailableSection(name, callgrindFile, size, notes);
  }

  const partial = {
    name,
    slug,
    command,
    events,
    cost: config.cost || "CEst",
    callgrind_file: path.basename(callgrindFile),
    markdown,
    ...structured,
  };
  const partialFile = path.resolve(outputDirectory, `profile-${slug}.json`);
  fs.writeFileSync(partialFile, `${JSON.stringify(partial, null, 2)}\n`, "utf8");

  return { partial, partialFile, callgrindFile: path.resolve(callgrindFile), markdown };
}

function profile({
  name,
  command,
  events = 0,
  run = 1,
  config,
  callgrindArgs = [],
  outputDirectory = "callgrinder",
  workingDirectory = ".",
  timeoutSeconds = 0,
}) {
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

  return summarizeCallgrind({ name, callgrindFile, config, events, command: expanded, outputDirectory });
}

module.exports = { expandCommand, profile, summarizeCallgrind };
