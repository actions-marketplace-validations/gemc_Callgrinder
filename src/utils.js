const fs = require("node:fs");
const path = require("node:path");

function getInput(name, fallback = "") {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = process.env[key];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function getIntegerInput(name, fallback, minimum = 0) {
  const raw = getInput(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}; received ${raw}`);
  }
  return value;
}

function appendFileFromEnvironment(variable, value) {
  const destination = process.env[variable];
  if (!destination) {
    return;
  }
  fs.appendFileSync(destination, `${value}\n`, "utf8");
}

function setOutput(name, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const delimiter = `CALLGRINDER_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  appendFileFromEnvironment("GITHUB_OUTPUT", `${name}<<${delimiter}\n${text}\n${delimiter}`);
  console.log(`output ${name}: ${text}`);
}

function appendSummary(markdown) {
  appendFileFromEnvironment("GITHUB_STEP_SUMMARY", markdown.trimEnd());
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "profile";
}

function walkJsonFiles(directory) {
  const files = [];
  if (!fs.existsSync(directory)) {
    return files;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonFiles(filename));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(filename);
    }
  }
  return files;
}

module.exports = {
  appendSummary,
  ensureDirectory,
  getInput,
  getIntegerInput,
  setOutput,
  slugify,
  walkJsonFiles,
};
