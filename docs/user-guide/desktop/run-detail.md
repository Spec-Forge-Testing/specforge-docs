# Run detail

The run detail is one saved run, read from the core's
[`get_run`](../../modules/core/protocol/run-detail.md). It has two tabs: **Findings**, the
defects and the findings that did not confirm, and **Endpoints**, how each endpoint was probed.
A finding opens in an inspector docked beside the list. In Simple the screen is the same, with
less on it ([what Simple leaves out](modes.md#what-simple-leaves-out)).

## The header

The title names the run and how it was set up. A run started from a preset, built-in or yours,
names that preset; a run of a preset of several runs also says which one it was:

```text
Run #12 · Quick check
Run #14 · Nightly security · run 2 of 3
```

A Custom run, a replay, and a run from a core that does not record its preset are named by their
mode and strategy instead (`Run #9 · Stateless · Security`). The preset is the one the run was
started as, so a run of a preset deleted since still names it.

!!! note "Version"
    A run names its preset, and **Run again** sets it up as it ran, with a core that speaks
    protocol `0.2.7` or later (report `1.29`). An older core's runs show their mode and strategy,
    and Run again starts from those alone.

### What went wrong, and what to do

Under the verdict, one line per thing that kept the run from a plain pass: where it was cut, then
each reason the core gave for a result that is not fully reliable, in the core's order. Each
reason comes with what to do about it: the core's own sentence when it sends one, else the app's,
such as "Check that the API is running at http://localhost:8000, then run again." Where a reason names
endpoints, its line links to them on the **Endpoints** tab. The reasons are the core's
[signal causes](../../modules/core/protocol/vocabularies.md#signal-causes).

## Run again { #run-again }

**Run again** (New requests, same setup) opens the new-run screen set up like this run. It sends
new requests; **Replay run** sends the same ones again.

| The run | What Run again sets up |
| --- | --- |
| Started from a preset this app offers, built-in or [yours](saved-presets.md) | That preset, whole, with the run's rule source and base URL |
| Custom, or from a preset no longer offered | A Custom plan of this run, with the request count and limits it used |
| From a core that does not record its setup | A Custom plan of its mode and strategy |

With LLM rules, the cap is the one the first run had: the cap the saved preset keeps, else the one
the run recorded when it was the first of its chain. A later run of a chain recorded only what the
chain had left, so the review keeps its own cap then. For a run of one of your presets, the screen
first reads your presets ("Reading your presets to set this run up again…"), then opens on the
preset.

Side effects are never set up again on their own. When the run was made with side effects
allowed, the app asks first, **Run again with side effects?**: running it again may create, change
or delete data on the API, and send what the safety guard otherwise holds back.

| Answer | What happens |
| --- | --- |
| Allow side effects | The review shows a box for this run, checked; other runs of its preset keep theirs unchecked. You still review before the start |
| Run without side effects | The review shows this run's box unchecked |
| Cancel | Nothing opens |

In both cases the plan-wide **Allow side effects** switch opens off; the boxes work as for a
[saved preset](saved-presets.md#side-effects-saved-in-a-preset).

## When a run reads clean { #clean }

Green is a pass, and only the run detail and the end of a run give one. A finished run reads
green only when all of this holds:

- it ran its whole plan (`completed`) with a clean signal, and probed something;
- it confirmed no defect;
- it holds no [LLM suspicion](../findings-and-suspicions.md);
- no finding is still waiting to be confirmed (`unverified` or `flaky`);
- credentials were not refused on part of the run: the contract items refused to every user are
  under a tenth of what the run had, and no endpoint had all its items refused.

A refuted finding was ruled out: it neither waits nor takes the green away, and is named apart.
A run whose only findings were refuted can read green. When the run detail lists no defect, its
line says what is left: `No confirmed defects · 2 not confirmed · 1 refuted`, or with
"but every identity's credentials were refused on part of the run: check the identities file".
The end of a run says `Completed · no defects confirmed · 3 findings could not be confirmed`, or
`Completed · credentials refused on part of the run`, in a neutral colour. A replay never reads
green: it judges recorded requests, not the API as a whole.

The rows of the **Runs** list and the Workspace's recent runs are never green: a row cannot tell
whether credentials were refused on part of the run. A row that passes everything else reads
**No defects**, in a neutral colour; open the run for its verdict. A row also needs the core's
count of findings still waiting
([`findings_unconfirmed`](../../modules/core/protocol/run-detail.md#findings-unconfirmed)) to read
**No defects**; a core older than `0.2.7` does not send it, so its rows read their status instead.

## Load steps of a performance run

A `performance` run on the concurrency ladder measures every endpoint at each load step. On the
**Endpoints** tab, open an endpoint's breakdown to read one line per step:

```text
At concurrency 1    p95 12 ms · held
At concurrency 4    p95 14 ms · held
At concurrency 16   p95 41 ms (again 39 ms) · slowed down
```

| Verdict | Meaning |
| --- | --- |
| held | The step's p95 latency stayed within the slow-down tolerance of the first step |
| slowed down | The step slowed down more than queueing explains; shown in warning colour |
| unmeasured | The step, or the first step it is compared with, got no samples, so it could not be judged; shown in warning colour |

`(again …)` is the second measurement of a step that slowed down, taken to confirm it. A
slow-down that holds is a `latency_degradation` finding on the **Findings** tab. The tolerance and
the steps are set on the [run's settings](new-run.md#the-settings-of-a-run); the core's side is
described in [Execution modes](../../modules/specforge-engine/execution-modes.md#the-concurrency-ladder).

## Endpoints without an LLM contract

With LLM rules, an endpoint can end up without a contract: the model's answer could not be used,
the cost cap ran out, or its handler could not be traced. The run still goes on, and is
**degraded**. Below the findings or endpoints list, one collapsed line counts them:

```text
18 endpoints without an LLM contract      Show which and why
```

**Show which and why** opens them grouped by what happened to them, then by the reason the core
gave, shown as it worded it:

| Group | What it did to the endpoints |
| --- | --- |
| Schema only | Fuzzed from the OpenAPI alone, without the LLM contract |
| Withheld | Not fuzzed as a target: each handler declared a risk and no contract could vouch for it |

The labels come from the core's
[exclusion dispositions](../../modules/core/protocol/vocabularies.md#producer-exclusion-disposition);
a disposition the app does not know yet is listed with its label and no colour. The line is never
shown calmer than a warning, whatever the groups hold, because the run did not get every contract
it asked for.
