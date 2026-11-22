# Resource adapter benchmark

The three benchmark arms receive the same starter repository and task prompt.
Python 3.11 or newer runs the benchmark with the standard library.

| Path | Role |
| --- | --- |
| [`starter_repo/`](starter_repo/) | Standalone submission template with public adapter interfaces and exceptions |
| [`task_spec.md`](task_spec.md) | Shared implementation prompt |
| [`reference_solution/`](reference_solution/) | All ten reference adapters, including the KV Memory implementation example |
| [`hidden_eval/`](hidden_eval/) | Evaluator and adapter contract tests |

## Run the benchmark

From the repository root, run the default mock mode and open
[`results/latest.md`](results/latest.md) or [`results/latest.json`](results/latest.json).

```sh
python benchmarks/run_benchmark.py --mock --out-dir benchmarks/results --seed 42
```

Use `--out-dir` to send both files elsewhere and `--work-dir` to choose a fresh
workspace root. The runner defaults to a new system temporary directory and
prints its path. It retains `arm_A/`, `arm_B/`, and `arm_C/` for inspection.
Each arm begins with a copy of `starter_repo/`. The default scoreboards are
generated artifacts ignored by Git.

| Arm | Live workflow | Mock profile |
| --- | --- | --- |
| A | `deepseek-v4.1-flash@max` completes the shared task in one invocation. | Seven adapters and two edits to frozen contract files |
| B | `opus@high` or `gpt-6.2-sol@max` implements the adapters sequentially in one session. | Nine adapters, the longest simulated runtime, and 100% flagship share |
| C | VibeBaton runs Claude planning and review, Codex critical work, and DeepSeek API bulk work through its configured CLIs. | All ten adapters and a 30% flagship share |

### Live mode

```sh
python benchmarks/run_benchmark.py --live --config .baton/baton.toml --out-dir /path/to/results --work-dir /path/to/fresh-work
```

`--config` is optional. The runner uses the standard VibeBaton configuration
lookup and Git to prepare each arm workspace. Configure `tactical_planner`,
`critical_executor`, `bulk_worker`, and `milestone_reviewer`, their CLI commands,
and their CLI login or API credentials.
Use [`baton.example.toml`](../baton.example.toml) as a starting point.
Arm A uses the bulk provider with the Flash baseline. Arm B uses the reviewer
when it is configured for one of the two flagship baselines and uses the
critical provider with `gpt-6.2-sol@max` otherwise. A failed provider preflight
skips the live run with configuration guidance and leaves existing reports in
place.

In arm C, the shared task and final hidden score serve as L0 input and
evaluation. Claude plans at L1. Codex implements the rate limiter, retry policy,
and circuit breaker at L2. DeepSeek completes the remaining adapters and package
exports at L3. The public unittest gate must discover and pass tests before the
L1 review. The runner verifies each stage's permitted writes and stops advancing
arm C after a provider, path, or public test gate failure. The resulting
submission still goes through hidden evaluation.

Provider calls run in the arm workspaces, with prompt and output files under
`--work-dir`. The CLIs use the host permissions and account directories set by
their configuration. CLIs with access to the source checkout can read
`hidden_eval/` and `reference_solution/`. A blind run requires restricting
provider access to those directories.

The evaluator uses a fresh Python process in a separate system temporary
directory for each arm. A timeout or an invalid result summary scores the
affected arm zero over the full suite. The runner evaluates all three arms
and records the failure in both scoreboards. The JSON field `eval_error` is
either `timeout` or `invalid_summary` and appears on affected arms.

### Scoreboard metrics

| Metric | Definition |
| --- | --- |
| Hidden Eval Pass Rate | Successful hidden test methods divided by the full reference suite size. Missing implementations, failures, errors, and skips earn zero points. JSON includes both counts and the fraction. |
| Contract Violations | Distinct files changed outside the permitted stage paths. The shared `adapters/base.py` and `adapters/errors.py` are frozen. Only the ten implementation modules, package exports, and public tests may be edited, with narrower scopes for arm C's stages. |
| Wall-Clock Time | Live elapsed seconds from starter copy through hidden evaluation. Mock mode uses fixed simulated durations. |
| Flagship Invocation Share | In live mode, the fraction of CLI calls using an arm B baseline model or a model classed as flagship in the VibeBaton catalog. Mock mode uses the simulated invocation mix. |

Keep the same code revision, Python version, and `--seed` to reproduce mock
results. The seed selects the included adapters. Arm scores and Markdown are
stable across runs. JSON includes the UTC generation time for each run.
Live scores reflect the configured providers, model behavior, and machine timing.

## Run the evaluator

From the VibeBaton repository root, run the aggregate suite or the individual
KV Memory contract. With `VIBEBATON_BENCH_TARGET` unset, both commands import the
top-level `adapters` package from `benchmarks/reference_solution`.

```sh
python -m unittest benchmarks.hidden_eval.test_hidden_contract -v
python -m unittest benchmarks.hidden_eval.contracts.test_kv_memory -v
```

Set `VIBEBATON_BENCH_TARGET` to a submission root containing
`adapters/__init__.py`. Relative paths resolve from the current working
directory. Run each target in a fresh Python process.

```sh
VIBEBATON_BENCH_TARGET=/path/to/submission python -m unittest benchmarks.hidden_eval.test_hidden_contract -v
```

```powershell
$env:VIBEBATON_BENCH_TARGET = 'D:\path\to\submission'
python -m unittest benchmarks.hidden_eval.test_hidden_contract -v
```

Use [`kv_memory.py`](reference_solution/adapters/kv_memory.py) and
[`test_kv_memory.py`](hidden_eval/contracts/test_kv_memory.py) as the pattern for
reference implementations and contract tests. The aggregate suite discovers
each `hidden_eval/contracts/test_*.py` module. Obtain implementation classes and
exceptions from the selected package through `load_target()`.
