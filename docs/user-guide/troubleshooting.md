# Troubleshooting

Common problems, what causes them, and how to fix them. Terms in this page are defined in the
[Glossary](glossary.md) and the [Core Concepts](concepts.md) page.

## The environment is not ready

**Symptom.** `doctor` reports a check as *critical* or a *warning*.

**Cause.** A pipeline component is missing or misconfigured — a library not installed, the LLM
not set up, the test runtime absent.

**Fix.** Run `doctor --fix`. It shows the install plan, asks for confirmation (or pass `--yes`),
runs only the catalog's own install commands, and re-checks. Items it cannot install
automatically are shown so you can resolve them by hand.

## `fuzz` refuses: the engine is not installed

**Symptom.** `fuzz` answers *"Fuzzing requires the 'contract-engine' and 'custom-schemathesis'
libraries"* and does nothing.

**Cause.** The fuzzing engine is an optional dependency and is not installed in this
environment.

**Fix.** Install it — `pip install -e lib/contract_engine -e lib/custom_schemathesis` — or run
`doctor --fix`, which does the same.

## "History unavailable: storage engine not installed"

**Symptom.** `history`, `inspect`, `replay`, `compare` or `prune` report the storage engine is
not installed; a `fuzz` run warns *"Run not saved: storage engine unavailable"* but still
prints its findings.

**Cause.** The storage library is optional and is not installed, so runs cannot be saved or
browsed. Fuzzing itself still works.

**Fix.** Install the storage engine (see `doctor`), then re-run.

## The target is down / connection refused

**Symptom.** A run stops early with *"Run aborted: the target stopped responding"*; the report
marks it truncated (`target_down`) and says the remaining endpoints were skipped.

**Cause.** The live API at `--base-url` stopped answering while the run was exploring it.

**Fix.** Confirm the API is running and reachable at the exact `--base-url` you passed, then
re-run. A truncated run is saved, so you can inspect what it reached before it was cut.

## "--latency-sla-ms only applies to --mode performance"

**Symptom.** `fuzz` refuses with that message.

**Cause.** The latency threshold is a performance-mode oracle; it means nothing in the other
modes.

**Fix.** Add `--mode performance`, or drop `--latency-sla-ms`.

## An unsupported schema construct stops the run

**Symptom.** *"Unsupported Schema Construct"* — the engine could not compile something in the
spec, and the whole run stops there.

**Cause.** One endpoint's schema uses a construct the engine cannot yet generate inputs for.

**Fix.** Fix the schema, or narrow the run to the endpoints you can test with `--endpoint` and
`--method` so the offending one is left out.

## `replay` refuses: credentials or target missing

**Symptom.** `replay` refuses over missing identities or a base-URL problem.

**Cause.** A replayable recipe keeps an identity's *label* but never its credentials, and keeps
the target's host but never any `user:pass@` it carried. If the original run used identities
or embedded credentials, a replay needs them supplied again.

**Fix.** Re-supply the identities with `--identities <file>.toml` (point it at the same file the
run was recorded under) and, if the recorded target carried credentials, pass them with
`--base-url`. A replay cannot be pointed at a different host than it was recorded against.

## `prune` will not delete without confirmation

**Symptom.** `prune` prints a plan but deletes nothing, or refuses because there is no terminal
to confirm in.

**Cause.** `prune` never deletes silently: a plan that removes anything asks first.

**Fix.** Review the plan, then pass `--yes` to approve it. Deleting an analysis's recorded
trace additionally requires `--include-traces` — `--yes` alone never removes a trace.

## The LLM is not configured

**Symptom.** `doctor` flags the LLM configuration, or the inference step is skipped.

**Cause.** No model or provider credential is set.

**Fix.** Configure a model and its API key as described in [LLM Providers](llm-providers.md).
Fuzzing straight from the spec does not need an LLM; only the business-rule inference does.

## Windows and CI notes

- **CI / non-interactive shells.** Set `SPECFORGE_SYSTEM_COMMANDS=0` to disable the `!`
  shell-escape when running Spec Forge unattended. See [Environment Variables](environment.md).
- **Git Bash mangles paths.** In Git Bash, an argument like `--endpoint /users` is rewritten to
  a Windows path. Prefix the command with `MSYS_NO_PATHCONV=1` to pass it through unchanged.
