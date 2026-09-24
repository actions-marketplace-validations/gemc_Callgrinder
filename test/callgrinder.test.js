const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cest, isNamedRoutine, locationToFunc, parseAnnotate } = require("../src/callgrind");
const { collectRows, loadConfig } = require("../src/categories");
const { renderProfile, topRoutines } = require("../src/report");
const { summarizeCallgrind } = require("../src/profile");

// A synthetic callgrind_annotate --inclusive output, with the (NN%) percentages callgrind adds.
const ANNOTATE = `Events shown:     Ir I1mr D1mr D1mw ILmr DLmr DLmw
--------------------------------------------------------------------------------
1,000,000,000 (100.0%)  0  0  0  0  0  0  PROGRAM TOTALS
--------------------------------------------------------------------------------
Ir I1mr D1mr D1mw ILmr DLmr DLmw file:function
--------------------------------------------------------------------------------
  400,000,000 (40.0%)  0  0  0  0  0  0  /o/G4PropagatorInField.cc:G4PropagatorInField::ComputeStep(G4FieldTrack&)
  120,000,000 (12.0%)  0  0  0  0  0  0  /o/gfield.cc:GField_AsciiMapFactory::GetFieldValue(double const*, double*) const (5,539,090x)
   80,000,000 (8.0%)  0  0  0  0  0  0  /o/flux.cc:GFluxDigitization::digitizeHit(GHit*, unsigned long) [/o/flux.gplugin]
    2,000,000 (0.2%)  0  0  0  0  0  0  events annotated
   50,000,000 (5.0%)  0  0  0  0  0  0  0x0000000009fe6140 (20x)
`;

test("cest applies the KCachegrind cache formula", () => {
  assert.equal(cest({ Ir: 100, I1mr: 1, D1mr: 1, ILmr: 1 }), 100 + 10 * 2 + 100 * 1);
});

test("percentages, call counts, objects, and unresolved addresses are cleaned", () => {
  assert.equal(locationToFunc("a.cc:Foo::Bar(int) const (5,539,090x)"), "Foo::Bar(int) const");
  assert.equal(locationToFunc("0x00000000118e8b70 (99x) [/o/libG4.so]"), "0x00000000118e8b70 in libG4.so");
  assert.equal(locationToFunc("0x0000000009fe6140 (20x)"), "0x0000000009fe6140 (unresolved)");
});

test("summary artifacts are filtered from routine lists", () => {
  assert.equal(isNamedRoutine("events annotated"), false);
  assert.equal(isNamedRoutine("__ieee754_atan2_fma"), true);
  assert.equal(isNamedRoutine("Foo::Bar(int, int)"), true);
});

test("parseAnnotate tolerates percentages and finds totals + rows", () => {
  const { total, rows } = parseAnnotate(ANNOTATE);
  assert.equal(cest(total), 1_000_000_000);
  const funcs = rows.map(([func]) => func);
  assert.ok(funcs.includes("G4PropagatorInField::ComputeStep(G4FieldTrack&)"));
  assert.ok(funcs.some((f) => f.startsWith("0x0000000009fe6140")));
});

test("source annotations and inclusive call-site costs never become self-cost routines", () => {
  const source = `
--------------------------------------------------------------------------------
-- Auto-annotated source: /o/run.cc
--------------------------------------------------------------------------------
Ir I1mr D1mr D1mw ILmr DLmr DLmw
  900,000,000 0 0 0 0 0 0 => ???:0x0000000004110690 (1x)
  900,000,000 0 0 0 0 0 0 => ???:0x000000000a05b040 (1x)
   80,000,000 0 0 0 0 0 0 => /o/flux.cc:GFluxDigitization::digitizeHit(GHit*, unsigned long) (1x)
   10,000,000 0 0 0 0 0 0 42 return work();
  990,000,000 0 0 0 0 0 0 events annotated
`;
  const { total, rows } = parseAnnotate(ANNOTATE + source);
  assert.deepEqual(rows, parseAnnotate(ANNOTATE).rows);
  const ranked = topRoutines(rows, 10);
  assert.ok(ranked.reduce((sum, [, value]) => sum + value, 0) <= cest(total));
  assert.ok(!ranked.some(([func]) => func.includes("0x0000000004110690")));
  // A real unresolved routine in the flat table must still be retained.
  assert.ok(ranked.some(([func]) => func.includes("0x0000000009fe6140")));
});

test("missing function-table headers produce a diagnostic instead of guessing at rows", () => {
  assert.throws(
    () => parseAnnotate(ANNOTATE.replace("Ir I1mr D1mr D1mw ILmr DLmr DLmw file:function", "")),
    /no 'file:function' table/,
  );
});

test("category table reports inclusive and self costs from the two passes", () => {
  const incl = parseAnnotate(ANNOTATE).rows;
  const self = [
    ["GField_AsciiMapFactory::GetFieldValue(double const*, double*) const", { Ir: 40_000_000 }],
    ["G4PropagatorInField::ComputeStep(G4FieldTrack&)", { Ir: 1_000_000 }],
  ];
  const config = loadConfig(
    JSON.stringify({
      categories: [
        { label: "Track swimming", match: "G4PropagatorInField::ComputeStep" },
        { family: "Field evaluation", discover: "(GField_[A-Za-z0-9_]*)::GetFieldValue" },
        { family: "Digitization", discover: "([A-Za-z_]\\w*)::digitizeHit" },
      ],
    }),
  );
  const rows = collectRows(config, incl, self);
  const field = rows.find((r) => r.label.startsWith("Field evaluation"));
  assert.equal(field.incl, 120_000_000);
  assert.equal(field.self, 40_000_000);
  const swim = rows.find((r) => r.label === "Track swimming");
  assert.equal(swim.self, 1_000_000);
  assert.ok(rows.some((r) => r.label === "Digitization: GFluxDigitization"));
});

test("a symbol in several objects stays bounded: inclusive is max, self is summed", () => {
  // The same demangled symbol lives in two objects (a COMDAT template copy / per-plugin
  // instantiation), so it appears in two rows. Their inclusive subtrees overlap, so the per-symbol
  // inclusive is the dominant copy (max), never the sum (which would exceed 100%). Self instructions
  // are disjoint, so self is summed.
  const incl = [
    ["Dispatch::run()", { Ir: 850_000_000 }],
    ["Dispatch::run()", { Ir: 800_000_000 }],
  ];
  const self = [
    ["Dispatch::run()", { Ir: 200_000_000 }],
    ["Dispatch::run()", { Ir: 150_000_000 }],
  ];
  const config = loadConfig(JSON.stringify({ categories: [{ label: "Dispatch", match: "Dispatch::run" }] }));
  const [row] = collectRows(config, incl, self);
  assert.equal(row.incl, 850_000_000); // max, not the 1.65e9 sum
  assert.equal(row.self, 350_000_000); // sum of disjoint self costs
  assert.ok(row.self <= row.incl);
});

test("renderProfile emits both tables and excludes the artifact routine", () => {
  const { total, rows } = parseAnnotate(ANNOTATE);
  const config = loadConfig(JSON.stringify({ categories: [{ family: "F", discover: "(GField_\\w+)::GetFieldValue" }] }));
  const { markdown } = renderProfile({ title: "t", config, inclTotal: total, inclRows: rows, selfRows: rows });
  assert.match(markdown, /\| Inclusive \(Mcycles\) \| Inclusive % \(overlapping\) \| Entry self % \|/);
  assert.match(markdown, /Top \d+ routines by self cost/);
  assert.doesNotMatch(markdown, /events annotated/);
});

test("top-routine shares partition direct cost while inclusive category shares can overlap", () => {
  const config = loadConfig(JSON.stringify({
    top_routines: 2,
    categories: [{ label: "A", match: "^A$" }, { label: "B", match: "^B$" }],
  }));
  const { markdown, structured } = renderProfile({
    title: "Overlapping calls",
    config,
    inclTotal: { Ir: 1_000_000 },
    inclRows: [["A", { Ir: 1_000_000 }], ["B", { Ir: 800_000 }]],
    selfRows: [["A", { Ir: 200_000 }], ["B", { Ir: 500_000 }], ["C", { Ir: 300_000 }]],
  });
  assert.match(markdown, /\| 1 \| `B` \| 0.5 \| 50.00% \|/);
  assert.match(markdown, /\| 2 \| `C` \| 0.3 \| 30.00% \|/);
  assert.match(markdown, /Listed routines: \*\*80.00%\*\*.*Remaining routines: \*\*20.00%\*\*/);
  assert.match(markdown, /\| A \| `\^A\$` \| 1.0 \| 100.00% \| 20.00% \|/);
  assert.match(markdown, /\| B \| `\^B\$` \| 0.8 \| 80.00% \| 50.00% \|/);
  assert.equal(structured.top_routines[0].incl, 800_000);
  assert.equal(structured.top_routines[0].self, 500_000);
});

test("topRoutines ranks by self cost and drops artifacts", () => {
  const rows = parseAnnotate(ANNOTATE).rows;
  const ranked = topRoutines(rows, 10).map(([func]) => func);
  assert.equal(ranked[0], "G4PropagatorInField::ComputeStep(G4FieldTrack&)");
  assert.ok(!ranked.includes("events annotated"));
});

test("summarizeCallgrind degrades gracefully when annotate fails", () => {
  // callgrind_annotate is not available in the test environment, so both passes fail; the summary
  // must be a visible diagnostic (with the file size), not a thrown error.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callgrinder-test-"));
  const file = path.join(dir, "callgrind.out.x");
  fs.writeFileSync(file, "");
  const result = summarizeCallgrind({
    name: "empty",
    callgrindFile: file,
    config: JSON.stringify({ categories: [] }),
    outputDirectory: dir,
  });
  assert.match(result.markdown, /Profile summary unavailable/);
  assert.match(result.markdown, /0 bytes/);
  assert.ok(fs.existsSync(result.partialFile));
});
