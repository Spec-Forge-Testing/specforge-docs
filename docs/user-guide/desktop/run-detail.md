# Run detail

The run detail is one saved run, read from the core's
[`get_run`](../../modules/core/protocol/run-detail.md). It has two tabs: **Findings**, the
defects and the findings that did not confirm, and **Endpoints**, how each endpoint was probed.
A finding opens in an inspector docked beside the list. This page covers two parts of it: the
load steps of a performance run, and the endpoints that ran without an LLM contract.

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
