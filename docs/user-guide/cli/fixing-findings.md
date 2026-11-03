# Fixing findings

The packaged client can explain a finding, propose a patch and apply it after you review the requested changes.

## Fixing a finding

When a run finds a server error (a `5xx` the contract says the API must never answer with), the
CLI can take it from there: price a fix, ask a model for it, show you the diff, and apply it to
your code if you say so. Each step asks before it does anything, because two of them are not
free: one spends money, and one changes your files.

```text
fuzz            →  "Finding #4: GET:/export answered 500, ×116. A fix can be proposed for it."
                    the price of asking, and `approve`                     (spends)
propose_fix     →  the diff. Nothing has touched your code.
                    "Applying this fix changes app/export.py.", and `approve`   (changes files)
apply_finding_fix → the files that changed, and what to run next
replay_finding  →  does the request that found it still fail?
```

### In the interactive session

After `fuzz`, `run_pipeline` or `get_run` shows a confirmed server error, the session leaves a
fix waiting. It takes the one the run repeated most and shows its price, taken from
[`estimate_finding_fix`](../specforge-cli-reference.md#estimate_finding_fix) — which sends nothing to a model:

1. Type `approve` to be asked about the spend. Only `y` approves. The model's answer comes
   back as a diff, with the reason for it and the edits that were left out.
2. The session then leaves the next question waiting: apply it? It lists the files it would
   change. Type `approve` again to be asked; nothing is written before that.
3. After it is applied, the suggestions are to run the endpoint again (`fuzz target=…`) and to
   compare that run with the one that found the problem (`compare_runs`).

Carrying on with any other line drops whatever was waiting, and nothing was sent. You can also
start from the price yourself: `estimate_finding_fix finding_id=4` or
`estimate_finding_explanation finding_id=4` leaves the matching `propose_fix` or
`explain_finding` waiting for `approve`, so the token is never copied by hand.

No fix is offered, and nothing is said, when the run found no server error, when the
finding's handler code cannot be reached (the run traced no folder, or its endpoint was not in
it: see `STATIC_ANALYSIS_REQUIRED` below), or when no model is configured. Only the worst
problem of a run is offered. The report names the findings behind each problem
(`findings #426, #428`), so for another one you can type `propose_fix finding_id=<#>` straight
away. `inspect_finding_source finding_id=<#>` tells you beforehand whether its code can be
reached.

### From a shell: `--fix`

```bash
specforge fuzz --project ./my-api --base-url http://localhost:8000 --fix
```

Runs the same chain in one call: the run, then each step shown and asked in turn. Answering no
at any step stops there, leaves your code as it was and does not fail the command. `--fix`
asks you, so it cannot go with `--yes`, `--ci` or `--json-output`, nor without a terminal, and
it applies only to `fuzz` and `run_pipeline`: all of those are refused with exit `2` **before the
run starts**, so a call that could never finish does not spend one first.

`specforge estimate_finding_fix --finding-id 4` on its own stays a free read: it prints the
price and asks nothing.

### Checking a fix and undoing it

A fix that applies cleanly can still miss. `replay_finding finding_id=4` sends again the one
request the finding was reported from and says whether it still fails. It needs no new run.

| What it says | What it means |
| --- | --- |
| `answers as the fix asked` | The request no longer breaks its rule and the status is the one the contract expects. |
| `no longer fails, but not as the fix asked` | The rule holds now, but the status is not the expected one, for example a `200` where the contract asks for a `422`. |
| `still fails` | The same problem answers again. |
| `the server still runs the code from before the fix` | The server was not rebuilt, so the replay judged the old code. |

!!! warning "Rebuild before you replay"
    The replay judges whatever code the server is running. When its log shows code the fix
    changed, the CLI says so instead of giving a verdict. Rebuild or restart the service and
    replay again, or let `replay_finding finding_id=4 rebuild=true` do it. `inspect_service`
    tells you whether the service can be rebuilt.

`verify_finding_fix finding_id=4` does both steps: it builds the applied fix once and replays
the request. A build that fails on a file the fix edited takes the fix out again; any other
failure leaves it in. `revert_finding_fix finding_id=4` takes an applied fix out of your files.
Both change things, so both ask before they are sent, and a replay that could change the target
asks its own question, which `--yes` does not cover.

!!! tip "When the build refuses the fix"
    `propose_fix finding_id=4 mend_build=true` asks the model again, showing it what the build
    said. It needs a fix that a build refused and that is no longer in the tree.

### What it spends and what it changes

- **Spending.** `estimate_*` sends nothing to a model. `explain_finding` and `propose_fix` send
  one request each, at the price the estimate showed: the approval token stands for exactly that
  estimate, so if the code or the finding changed in between, the core asks again with the new
  price. A fix already paid for (an equivalent finding's) is reused and costs nothing.
- **Changing files.** Only `apply_finding_fix` writes, and only to the tree the finding's run
  traced. In a Git work tree it goes through `git apply` and the way back is Git; elsewhere each
  file keeps a `.bak` copy. If the tree changed since, it answers `conflict` and touches nothing.
- **A fix is a model's proposal.** A diff can apply cleanly and still not fix the problem, for
  example by using a name it never imported. Read it, and after applying run the endpoint again.

### Errors on this path

| Code | What it means | What the CLI suggests |
| --- | --- | --- |
| `STATIC_ANALYSIS_REQUIRED` | The finding's handler code cannot be reached: its run traced no folder that still exists, or tracing found no handler for the endpoint. Pointing `repo_root` at the wrong folder is the usual cause. | `analyze_endpoints repo_root=<folder with the API's code>`, then run the endpoint again: a finding keeps the tree its own run traced. |
| `REPO_ROOT_INVALID` | `repo_root` does not exist or is not a folder. | `analyze_endpoints repo_root=<folder with the API's code>` |
| `FINDING_FIX_FAILED`, `FINDING_EXPLANATION_FAILED` | No model could be asked, or the one asked gave nothing usable. When it ran out of time, the message says how to allow more: `set_config values={"llm.timeout_seconds": 120}`, or choose a faster model with `model`. | `diagnose`, `get_config` |
| `FIX_EMPTY_OR_UNAPPLICABLE` | None of the fix's edits held when it was proposed. | `propose_fix finding_id=<#> refresh=true` |
| `FIX_APPLY_FAILED` | Applying failed for a reason other than a conflict. The tree is as it was. | `get_finding_fix_patch finding_id=<#>`, to apply it by hand |
| `REPLAY_NOT_REPRODUCIBLE` | The finding needed earlier requests to build its state, or its request is not in the recorded trace. | `replay analysis_id=<#>`, to replay the whole run |
