# Callgrinder

Callgrinder shows which functions cost the most in your C/C++ application. Give it a command and it runs
[Valgrind](https://valgrind.org)'s **callgrind** profiler, then prints the hottest routines. An optional JSON
config groups functions into categories you care about.

Use it locally with `./callgrinder` or in GitHub Actions with `gemc/Callgrinder@v1`. Costs are estimated CPU
cycles (**CEst**), not elapsed seconds. To measure how runtime changes with thread count, use
[ThreadScale][threadscale].

[threadscale]: https://github.com/gemc/ThreadScale

## Prerequisites

- Linux, including a Linux VM or container on macOS or Windows.
- Node.js 24+, Git, and Valgrind (including `callgrind_annotate`).
- Your application compiled in **debug mode**, with debug symbols (`-g`; CMake: `-DCMAKE_BUILD_TYPE=Debug`).

Callgrinder itself has no npm dependencies or build step.

## Quickstart: profile your application

Compile your software in debug mode and check that your executable runs normally with its input files.
Then clone Callgrinder and pass it that same command:

```shell
git clone https://github.com/gemc/Callgrinder.git
cd Callgrinder

./callgrinder './build/bin/myapp input.dat' \
  --working-directory /path/to/your/project \
  --name my-workload --output-dir profile-results
```

Replace `/path/to/your/project` with your application's directory and `./build/bin/myapp input.dat` with your
executable and its arguments. The executable and input paths are relative to `--working-directory`. Start with
a small workload because profiling is much slower than a normal run.

The terminal prints the **Top routines** table. Category rows are empty until you supply a
[category config](#the-category-config). Results are saved under the Callgrinder checkout:

- `profile-results/callgrind.out.my-workload`: the raw profile for QCachegrind or KCachegrind.
- `profile-results/profile-my-workload.json`: the parsed results used to generate a report.

Save the summary as Markdown and export the category table as CSV:

```shell
./callgrinder report --input-dir profile-results --output-dir profile-report
cat profile-report/summary.md
```

This creates `summary.md`, `categories.csv`, and `callgrinder.json` in `profile-report/`. The CSV contains
category rows once you add a config.

Always pass `--output-dir` when running from the checkout: the default `callgrinder` directory name conflicts
with the `callgrinder` launcher file. Choose a different directory or profile name to keep earlier runs.

<br/>

## Command options

The command may contain `{events}`, `{name}`, and `{run}` placeholders. Quote the whole command as one
argument, and quote inner arguments that contain spaces:

```shell
./callgrinder 'gemc card.yaml -n {events} -gsystem="[{name: det, factory: ascii}]"' \
  --name det --events 100 --output-dir profile-results
```

Callgrinder runs the command as `valgrind --tool=callgrind … bash -c "exec <command>"`, so `exec` makes the
shell hand its process to your binary and callgrind profiles the binary directly rather than the shell.

If you would rather run `valgrind` yourself — for example to pass complex, space-containing arguments as a
shell array with no re-quoting — hand Callgrinder the resulting file and it only summarizes:

```shell
./callgrinder --from-callgrind profile-results/callgrind.out.my-workload \
  --name my-workload --output-dir profile-results
```

<br/>

## The category config

Categories are optional. Save your category definitions as `ci/callgrinder.json` and pass
`--config ci/callgrinder.json`. Config paths are relative to the directory where you invoke Callgrinder.
You can add categories to an existing profile without rerunning your application:

```shell
./callgrinder --from-callgrind profile-results/callgrind.out.my-workload --name my-workload \
  --config /path/to/your/project/ci/callgrinder.json --output-dir profile-results
./callgrinder report --input-dir profile-results --output-dir profile-report
```

Each category is either **fixed** (`match` names one entry symbol) or **discovered** (`discover` captures a
class in group 1 and reports one row per class found — e.g. every plugin of a kind):

```json
{
  "cost": "CEst",
  "top_routines": 10,
  "categories": [
    { "label": "Track swimming", "match": "G4PropagatorInField::ComputeStep" },
    { "family": "Digitization",  "discover": "([A-Za-z_]\\w*)::digitizeHit" },
    { "family": "Field",         "discover": "(GField_[A-Za-z0-9_]*)::GetFieldValue" }
  ]
}
```

- `match` — a regex naming one entry function; its inclusive and self cost become one row.
- `discover` — a regex whose group 1 captures a class; every matching class becomes its own row, labelled
  `"<family>: <class>"`. Add `"method": "…"` to control the displayed symbol when `discover` uses alternation.

`config` accepts a file path or inline JSON. See [GEMC3](examples/gemc3.json) and [GEMC2](examples/gemc2.json)
for application-specific examples.

<br/>

## Try it in GitHub Actions

Use a Linux runner with Valgrind already available. This example uses a self-hosted runner and a CMake
application; CMake and your compiler must also be available. Save it as `.github/workflows/profile.yml`,
replace the build commands with your project's debug build, and set `command` to your executable and inputs:

```yaml
name: Profile
on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  profile:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v6
      - name: Build your application in debug mode
        run: |
          cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
          cmake --build build --parallel
      - uses: gemc/Callgrinder@v1
        with:
          command: ./build/bin/myapp input.dat
          name: my-workload
          output-dir: profile-results
      - uses: gemc/Callgrinder@v1
        with:
          mode: report
          input-dir: profile-results
          output-dir: profile-report
      - uses: actions/upload-artifact@v7
        with:
          name: profile
          path: |
            profile-results/
            profile-report/
```

Once the workflow is on your default branch, open **Actions → Profile → Run workflow**. Read the tables in
the run summary and download the **profile** artifact for the raw profile and report files. Prepare any input
files your application needs before the Callgrinder step. Add `config: ci/callgrinder.json` when you have
defined your categories. The Action supplies its own Node.js runtime.

<br/>

## What the summary reports

- **Category table** — inclusive cost includes work in the entry routines and their callees. The
  `Inclusive % (overlapping)` column is not additive: the same work can appear in several categories.
  `Entry self %` counts only direct work in the matched entries; overlapping patterns can repeat that work.
- **Top routines** — select the routines with the highest `Self %`, then order those routines by inclusive
  `% of run`, largest first, with that column before `Self %`. This selection rule is
  **upcoming in the next release**.
  Inclusive shares include callees and overlap; only self shares sum to at most 100%, apart from rounding.
  Listed and remaining self-cost shares appear below the table. Call counts are stripped and unresolved
  addresses are labelled with their object when available.
- The function-table parsing fix shipped in v1.0.6. Regenerate older partial JSON reports with
  `--from-callgrind`; the application does not need to be profiled again.
- Cost is CEst (`Ir + 10·L1_misses + 100·LL_misses`), matching qcachegrind's cycle estimation. The report ends
  with a short qcachegrind reading guide.

<br/>

## Modes

- **`profile`** (default) — run one command under callgrind; write `callgrind.out.<name>`, a partial JSON, and
  a Job-Summary section.
- **`report`** — merge partial JSON files from `input-dir` into `summary.md`, `categories.csv`, and an
  aggregated JSON.
- **`discover`** — turn a JSON `benchmarks` array into a job matrix (one job per profile) for fan-out.

The reusable workflow `.github/workflows/callgrinder.yml` wires `discover → profile (matrix) → report`.

<br/>

## Development

```shell
npm run check   # node --check on the entry points
npm test        # node --test
```

No build step and no npm dependencies — keep it that way. See `releases/` for per-version notes.
