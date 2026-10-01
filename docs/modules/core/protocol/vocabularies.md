# Result vocabularies

The envelope does not type an operation's `result`, so the schema cannot list the
values a result field may take. The fields on this page are the ones a frontend
is expected to **branch on**: each takes only the values listed here, every one
of them may appear, and a new value is a protocol change with its own changelog
entry. This page is the one place they are enumerated; the other pages link here.

Where the same concept appears in a reply and in the report document that
`fuzz`, `replay` and `run_pipeline` answer with, it has the same name and the
same values in both. A missing fact is `null`, never an empty string; an empty
collection is `[]` or `{}`.

## `run.status` { #run-status }

How a stored run ended. In `list_runs`, `get_run` and the report document's
`run`.

| Value | Meaning |
| --- | --- |
| `completed` | The run went through its whole plan. |
| `truncated` | The run was cut short (`run.truncation` says why) and holds what it gathered until then. |
| `aborted` | The API went down, or a stateful chain could not be honored. |
| `cancelled` | The client asked the run to stop (see [cancellation](events.md#cancellation)). |
| `safety_breached` | Requests reached a route the safety guard held back; the run is kept, with that evidence. |

A run that fails outright is never stored, so `failed` is not a `run.status`.
The persistence layer stores these five values under a CHECK constraint.

## `run.comparability` { #comparability }

Whether this run's defects can be compared with another run's.

| Value | Meaning |
| --- | --- |
| `comparable` | The run can be compared as it is. |
| `truncated` | The run was cut short. |
| `aborted` | The run was aborted. |
| `cancelled` | The run was cancelled. |
| `safety_breached` | The run breached the safety guard. |
| `reduced_fidelity` | A replay that did not reproduce its trace exactly. |
| `unknown_status` | The run carries a status this build does not know. |

## `run.oracle_scope` { #oracle-scope }

Which oracles judged the run's responses. Two runs judged by different scopes
report different kinds of defect.

| Value | Meaning |
| --- | --- |
| `contract` | Every check the contract makes possible. |
| `contract_free` | Only the checks that need no contract, which is what a replay runs. |

The persistence layer stores these two values under a CHECK constraint.

## `truncation.reason` { #truncation-reason }

Why a pass stopped before its plan was exhausted. The run carries it in
`run.truncation`, and each entry of `endpoints` carries its own in `truncation`,
set when that endpoint's pass was cut short whether or not the run was.

| Value | Meaning |
| --- | --- |
| `infrastructure_abort` | Too many timeouts or transport failures in a row. |
| `deadline_exceeded` | The time budget ran out. |
| `target_down` | The API stopped answering; [`target_down_verdict`](#target-down-verdict) says how the run concluded it. |
| `state_link_abort` | A stateful chain could not be honored: a fault of the harness, not of the API. |
| `generation_exhausted` | No request could be generated for the endpoint. |
| `cancelled` | The client asked the run to stop. |

`detail` beside it is free text for a person, or `null`.

## `target_down_verdict` { #target-down-verdict }

How the run concluded the API was down. It sits on `run.truncation` and is set
only when the reason is `target_down`.

| Value | Meaning |
| --- | --- |
| `liveness_probe_failed` | A liveness probe against the API failed. |
| `circuit_breakers_open` | Every endpoint the run had sent requests to opened its circuit breaker. |

## Coverage dispositions { #coverage }

Every endpoint of an analysis falls into exactly one disposition, and `coverage`
counts each one: in `get_run` under `coverage.counts`, in `list_analyses` and
`get_analysis` under `coverage`, and in the report document flat in `coverage`
(`null` for a replay).

| Value | The endpoints that were... |
| --- | --- |
| `targeted` | Declared and fuzzed. |
| `excluded` | Declared, and rejected by the compiler; `excluded_endpoints` lists each with its `reason`. |
| `filtered` | Declared, and left out by the run's endpoint selection. |
| `reached_by_transition` | Never declared, and reached only by a stateful transition; `reached_by_transition_endpoints` lists each as `{method, path}`. |

`declared` is `targeted + excluded + filtered`: an endpoint reached by a
transition is never counted as declared. The persistence layer stores these four
values under a CHECK constraint.

## Comparison caveats { #caveats }

In `compare_runs`, each entry of `caveats` says why two runs' defect sets are
not directly comparable. `side` says whether it concerns the `before` run, the
`after` run or the `pair`; `detail` is free text for a person, or `null`.
Branch on `reason`, show `detail`.

| Value | Side | Meaning |
| --- | --- | --- |
| `truncated`, `aborted`, `cancelled`, `safety_breached`, `reduced_fidelity`, `unknown_status` | `before` / `after` | That run's [`comparability`](#comparability). |
| `engine_version_differs` | `pair` | The two analyses ran on different engine versions. |
| `engine_version_unknown` | `pair` | Neither analysis recorded its engine version, so they cannot be assumed equal. |
| `spec_differs` | `pair` | The analyses were generated against different spec revisions. |
| `execution_mode_differs` | `pair` | The analyses were generated in different execution modes. |
| `oracle_scope_differs` | `pair` | Different oracles judged the two runs. |
| `replay` | `after` | The later run is a replay: it records verdicts per recorded request, not crashes. |
| `replay_report_not_indexed` | `after` | The replay's report was never recorded. |
| `replay_report_missing` | `after` | The replay's report is no longer on disk. |
| `replay_report_corrupt` | `after` | The replay's stored report fails its integrity check. |
| `replay_report_unreadable` | `after` | The replay's report file cannot be opened. |
| `replay_report_undecodable` | `after` | The replay's report carries no verdicts this build can decode. |

With any of the five `replay_report_*` reasons, every change but a `new` one is
`inconclusive`: without the replay's verdicts, nothing can be ruled resolved or
persisted.

## Operation status { #operation-status }

How an operation ended: the reply's `status` and the `finished` event's.

| Value | Meaning |
| --- | --- |
| `completed` | The operation ran to its end. |
| `cancelled` | The client asked the operation to stop. |
| `failed` | The operation could not finish. |
| `safety_breached` | Requests reached a route the safety guard held back. |

`run_pipeline`'s own status ranks its stages: a safety breach outranks a stop
request, which outranks a failure; otherwise it is `completed`.

## Stage status { #stage-status }

How one stage of `run_pipeline` ended: the `status` of a `stage_finished` event
and of each entry in the reply's stage list.

| Value | Meaning |
| --- | --- |
| `completed` | The stage ran to its end. |
| `failed` | The stage could not finish. |
| `skipped` | The stage had nothing to do in this pipeline and did not run. |
| `stopped` | The stage stopped at the client's request. |

The execution stage reads the run's own outcome: a run that breached the safety
guard ends the stage `failed`, a cancelled one `stopped`.
