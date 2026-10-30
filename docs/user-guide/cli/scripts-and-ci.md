# Scripts, CI and approvals

Use the argv form when a command must run without a prompt, preserve machine-readable output or return a status to automation. This page also explains how confirmations and cost approvals behave when there is no interactive prompt.

## Argv-only flags

These are never part of any operation — they describe how *you* want the call
run and its result delivered, so every operation accepts them alike and the
catalog never lists them:

| Flag | Effect |
| --- | --- |
| `--project PATH` | Opens the project at `PATH` before the operation. Needed by any operation that `requires` a project or a contract, since a one-shot call starts with nothing open. |
| `--contract PATH` | Loads the contract at `PATH` once the project is open, for a project that declares none. Needs `--project`. |
| `--yes` | Answers yes to confirmations up front. See [Approvals and cost estimates](#approvals-and-cost-estimates) for what it does not cover. |
| `--fix` | On `fuzz` and `run_pipeline`: when the run finds a server error, offers a fix for it and applies it if you approve. Asks at every step, so it needs a terminal. See [Fixing findings](fixing-findings.md). |
| `--json-output` | The raw result as one JSON object on real stdout — no banner, no progress, no human render share that stream. A domain error renders to stderr as usual and stdout stays empty, so a script can always `> file.json` unconditionally. Long operations subscribe to no progress token at all in this mode. |
| `--ci` | No color (sets `NO_COLOR` before anything renders); exits `1` if the operation's own result carries findings (`fuzz`, `replay`, `run_pipeline`), if the operation itself failed, **or** if a run did not finish with status `completed` (`cancelled`, `failed`, `safety_breached`, or a report with no status). Exits `0` on a clean run. Combine with `--json-output` to get a script-friendly result and a pipeline-friendly exit code at once. |
| `--junit-xml PATH` | Also writes the result as JUnit XML at `PATH`, alongside whatever else rendered — one `<testsuite>` per endpoint, one `<testcase>` per defect (or a single passing one if the endpoint had none). Only `fuzz`/`replay`/`run_pipeline` results produce anything; anything else writes an empty `<testsuites/>`. |

```bash
specforge fuzz --project ./my-api --contract ./my-api/openapi.yaml \
  --base-url http://localhost:8000 --ci --junit-xml report.xml
echo $?   # 1 if fuzz found anything, or if it didn't complete
```

With no arguments at all, `specforge` opens the interactive session regardless of any of
these — they only apply once an operation name is given.

Ctrl-C during a one-shot call asks the core to cancel and still prints what the
run had produced; a second Ctrl-C stops waiting.

## Exit codes (argv form)

| Code | Meaning |
| --- | --- |
| `0` | The operation completed, and (under `--ci`) found nothing. |
| `1` | A domain or protocol error, a confirmation you answered no to (or an estimate that kept changing), or (under `--ci` only) a finding or a run that did not complete. |
| `2` | A usage error caught before the request was sent: an unknown operation, a missing required flag (`--project` included), a value outside an enum, JSON that failed to parse, a confirmation nobody could give, or `--fix` on an operation or a call that cannot take it. |
| `130` | Interrupted with Ctrl-C (also with `--ci`), or ended by `SIGTERM`/`SIGHUP` (`128` plus the signal number). |

## Approvals and cost estimates

Some operations ask for confirmation before spending money, sending requests with recorded side effects or changing files.

| What | When it asks | Answering up front |
| --- | --- | --- |
| Destructive operations (`apply_fix_plan`, `apply_prune_plan`, `apply_finding_fix`) | Before they are sent. | `--yes` |
| A run that would pay for LLM inference | The core returns its estimate; the CLI shows it and resends with the approval token. | `--yes`, but only with `producer.max_cost_usd` set; without a cap it stops with exit `2`. |
| Asking a model to explain a finding (`explain_finding`) | The core returns that finding's price; the CLI shows it and resends with the approval token. | `--yes` approves exactly the price shown. |
| Asking a model for a fix (`propose_fix`) | The same, with the fix's price. | Never. `--yes` stops with exit `2` and sends nothing: a person reads the price. |
| Applying a fix that was just proposed | After its diff is shown, including the files that change and `.bak` copies kept outside Git. | Never, even with `--yes`. |
| A replay that could change the target | The CLI explains why and asks. | `--allow-side-effects`. `--yes` does not cover it. |

In a non-interactive call, `--json-output`, `--ci` and a call with no terminal
never wait for an answer. Without `--yes` they stop with exit `2`; in
`--json-output` mode the estimate goes to stderr so stdout stays clean. Git Bash
(mintty) does not present itself to Python as a terminal, so a one-shot call
never asks: use PowerShell or `winpty`, or pass `--yes`.
