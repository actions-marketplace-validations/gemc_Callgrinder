# Callgrinder

Callgrinder profiles a command with [Valgrind](https://valgrind.org)'s **callgrind** tool and reports where the
time goes: a per-category table (with both inclusive and self cost) and a table of the hottest individual
routines, as **CEst** (cycle estimation). It runs three ways — a GitHub Action, a reusable workflow for
distributed fan-out, and a local `./callgrinder` command — and, like [ThreadScale][threadscale], it is a
zero-dependency Node.js 24 project.

[threadscale]: https://github.com/gemc/ThreadScale

It is application-independent: the categories you care about are supplied as a small JSON config, so the same
Action profiles any C/C++ program compiled with debug symbols.

<br/>

## Requirements

- A Linux runner (or container) with **`valgrind`** installed (it provides `callgrind_annotate`).
- **Node.js 24+**.
- Your application built **with debug symbols** — otherwise hot routines appear as unresolved `0x…` addresses.

Callgrinder does not build or prepare your app; the caller does that (build, generate inputs, set the working
directory) and passes a ready-to-run command, exactly like ThreadScale.

<br/>

## Quick start (Action)

```yaml
- uses: gemc/Callgrinder@v1
  with:
    command: 'build/bin/myapp input.dat -n {events}'
    name: my-workload
    events: '100'
    config: ci/callgrinder.json
    working-directory: .
```

The step profiles the command, writes `callgrind.out.my-workload`, and appends the category and top-routines
tables to the Job Summary.

<br/>

## Local command-line runs

```shell
./callgrinder 'build/bin/myapp input.dat -n {events}' --name my-workload --events 100 --config ci/callgrinder.json
```

The command may contain `{events}`, `{name}`, and `{run}` placeholders. Quote the whole command as one
argument, and quote inner arguments that contain spaces:

```shell
./callgrinder 'gemc card.yaml -n {events} -gsystem="[{name: det, factory: ascii}]"' --name det --events 100
```

Callgrinder runs the command as `valgrind --tool=callgrind … bash -c "exec <command>"`, so `exec` makes the
shell hand its process to your binary and callgrind profiles the binary directly rather than the shell.

<br/>

## The category config

Categories are JSON (native and zero-dependency, and it quotes regex backslashes cleanly). Each category is
either **fixed** (`match` names one entry symbol) or **discovered** (`discover` captures a class in group 1 and
reports one row per class found — e.g. every plugin of a kind):

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

`config` accepts a file path or inline JSON. See `examples/gemc3.json` and `examples/gemc2.json`.

<br/>

## What the summary reports

- **Category table** — for each category: inclusive `CEst (Mcycles)`, `% of run` (inclusive: entry + callees,
  overlaps and does not sum to 100%), and `Self %` (cycles executed directly in the entry function(s),
  non-overlapping).
- **Top routines** — the hottest individual routines by self cost, with callgrind call counts stripped and
  unresolved addresses labelled with their object.
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
