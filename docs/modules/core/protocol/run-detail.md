# Run detail

`get_run` reads a stored run back: its `run`, `metrics`, `endpoints`, `findings`
(paged with `limit`), `producer_exclusions` and, for a replay, what the replay
concluded. Most of it is the report document's own shape. This page explains the
facts a client has to read with care: what each finding counter counts, how an
endpoint's budget was spent per phase, what a stored replay ruled, and whether a
finding can be replayed alone. The closed values these fields take are on
[Result vocabularies](vocabularies.md).

## The finding counters { #metrics }

Every `findings_*` count in `metrics` is the engine's own, fixed when the run is
stored, and the same in `get_run` and the report document. Most of them count
**occurrences**, not defects: one defect seen on twenty requests that shrinking
could not reproduce is twenty `findings_flaky`. `unconfirmed_unique` counts the
same unconfirmed findings as **defects**, each once; it is counted when `get_run`
reads the run, and only `get_run` answers it.

| Field | What it counts |
| --- | --- |
| `total_requests` | Requests sent while exploring; those of the shrink are not among them. |
| `findings_raw` | Violations seen while exploring: a response that breaks two rules counts twice. In a stateful run, each confirmed report once, plus every occurrence of its refuted, unverified and flaky findings. |
| `findings_confirmed` | Shrunk representatives that reproduced, a second cause included, before deduplication. Where a runner does not shrink (`resilience`, `auth`, and the latency findings and crashes of `performance`), each distinct defect observed. |
| `findings_unique` | Confirmed reports after deduplication: as many as the report document's `defects`. |
| `findings_collapsed` | Occurrences left unshrunk because a faithful representative of their signature stands for them. |
| `findings_flaky` | Occurrences shrinking tried and could not reproduce a second time: not findings, and not distinct defects. |
| `findings_unverified` | Occurrences never tried (the run ended first, or the search had no candidate) or whose control request could not judge them; in a stateful run, what the step controls left unjudged; in `auth`, every finding only a contract can judge. |
| `findings_refuted` | Occurrences whose minimal request reproduced while its control request showed the same signal, so the input was not the cause; `0` where no control is sent. |
| `requests_shrink` | Requests sent while shrinking, and while `resilience` confirms its server errors. |
| `unconfirmed_unique` | The run's unconfirmed defects, each counted once: `total`, `flaky`, `unverified` and `refuted`. |

```json
"metrics": {"total_requests": 412, "findings_raw": 9, "findings_confirmed": 2,
            "findings_unique": 1, "findings_collapsed": 1, "findings_flaky": 4,
            "findings_unverified": 2, "findings_refuted": 0, "requests_shrink": 37,
            "unconfirmed_unique": {"total": 2, "flaky": 1, "unverified": 1, "refuted": 0}}
```

**What makes one defect.** Two unconfirmed findings are one defect when they share
the method, the path, the invariant and the status (a request no response answered
counts with the status its finding records) and, only when the invariant is about
who sent the request, the identity. That is the identity
[`compare_runs`](vocabularies.md#caveats) pairs defects by. The phase, the
response's shape, the reproducer and the rule do not split a defect: the same `500`
under two identities is one, and so are two semantic rules broken on one endpoint
with one status.

- **Over the whole run.** `unconfirmed_unique` counts every finding of the run,
  whatever page of `findings` was asked for.
- **Never twice.** A defect the run also confirmed is not counted: no defect is both
  among the confirmed findings and here.
- **Per state, at least once.** Each state counts the defects with at least one
  finding in it. A defect flaky in one phase and refuted in another counts in both,
  so `flaky`, `unverified` and `refuted` may add up to more than `total`.

A client that says "N unconfirmed defects" reads `unconfirmed_unique.total`. The
three occurrence counters size the funnel; they are not a number of findings to
show. `metrics` is `null` for a run that recorded none, and then there is no
`unconfirmed_unique` either.

## Budget per phase { #budget-by-phase }

Each entry of `endpoints` carries `budget_by_phase`: the examples each planned phase
got at that endpoint, in `get_run` and the report document. It is `{}` in a mode
that does not plan by phase.

| Field | What it holds |
| --- | --- |
| `planned` | The examples planned for the phase at this endpoint, every identity's share summed. |
| `carried_in` | The examples an earlier phase of the same identity left unspent and this phase received. |
| `starved` | The declared identities this phase's share left with zero examples, sorted; `[]` when it funded every one. |

```json
{"method": "PUT", "path": "/articles/{slug}", "starved_identities": ["bob"],
 "budget_by_phase": {
   "valid":    {"planned": 5, "carried_in": 0, "starved": []},
   "attack":   {"planned": 3, "carried_in": 0, "starved": []},
   "mutation": {"planned": 1, "carried_in": 0, "starved": ["bob"]}}}
```

A phase whose share is smaller than the number of identities funds some and
starves the rest. Above, `mutation` has one example for two identities: `alice`
gets it, `bob` gets none in that phase, and `bob` still has his examples, and may
have findings, in `valid` and `attack`. A phase planned with zero examples is
listed, `planned` `0`, when the run declares identities, with every one of them in
`starved`. A run stored before report `1.26` reads back `starved` `[]` in every
phase.

**`starved_identities` is the union of the phases' `starved`.** It names an
identity left with zero examples in **at least one** phase, not an identity the
endpoint never sent anything for. To say where an identity was left out, read the
phases: "bob got no examples in `mutation`", never "bob was left out of
`PUT /articles/{slug}`".

## A stored replay's verdicts { #replay }

A [`replay`](vocabularies.md#replay-verdicts) rules each defect the recorded run
confirmed. Its run keeps those verdicts in the store, so they read back after the
`replay` answer is gone and whatever retention did to its report.

`get_run` carries them in `replay`: `null` for a run that is no replay, for a
replay stored by a core older than protocol `0.2.2`, whose verdicts were kept only
in its report, and for a replay whose stored verdicts are fewer than the count
stored with them: part of them is never published.

| Field | What it holds |
| --- | --- |
| `judged` | The same object as the `replay` answer's `replay.judged`: `oracle_scope` (as [`run.oracle_scope`](vocabularies.md#oracle-scope)), `recorded_defects`, `present`, `possibly_resolved` and `inconclusive`. `recorded_defects` counts the recorded run's confirmed findings, one per phase a defect was confirmed in, not distinct defects. |
| `defect_verdicts` | One per confirmed finding of the recorded run, in the order the `replay` answer gave them: `finding_id` (the confirmed finding it rules on, an integer), `method`, `path`, `status_code`, `invariant_violated`, `rule_id` and `identity_label` as that finding was stored, and `verdict` (`present`, `possibly_resolved` or `inconclusive`). |

```json
"replay": {
  "judged": {"oracle_scope": "contract_free", "recorded_defects": 3, "present": 2,
             "possibly_resolved": 1, "inconclusive": 0},
  "defect_verdicts": [
    {"finding_id": 41, "method": "POST", "path": "/articles", "status_code": 500,
     "invariant_violated": "not_a_server_error", "rule_id": null, "identity_label": null,
     "verdict": "present"}]}
```

The `replay` answer and the report document's `replay.defect_verdicts` carry
`finding_id` too, so a client links each verdict to the finding it can open with
`get_finding`. In the report document it is optional: a report written before
`1.26` has none. A replay of a run that confirmed nothing has `defect_verdicts` `[]`
and every count of `judged` `0`; a replay whose verdicts are unknown is `null`,
never "zero of zero".

**`run.judged`**, in each row of `list_runs` and in `get_run`'s `run`, is the same
`judged`, and `null` whenever `replay` is. A replay's own `findings_unique` is
always `0`, since a replay records verdicts, not findings: a list of runs shows a
replay's row by its `judged` ("2 present, 1 possibly resolved"), and a `null` there
as verdicts unknown.

`compare_runs` against a replay reads these stored verdicts, so pruning the
replay's report changes nothing. Only a replay whose `replay` is `null` (stored
before `0.2.2`, or with incomplete stored verdicts) still reads its report, and only
it can raise a `replay_report_*` [caveat](vocabularies.md#caveats).

## Replaying a finding alone { #replay-alone }

Every finding, confirmed or not, carries `replay_alone` in `get_run` and
`get_finding`: whether [`replay_finding`](replay-and-fixes.md#replay-finding), and
so `verify_finding_fix`, can send its request alone.

```json
"replay_alone": {"possible": false, "reason": "not_in_trace"}
```

`reason` is `null` when `possible` is `true`; otherwise it is the
[reason](vocabularies.md#replay-alone-reason) `replay_finding` would refuse the
finding with, `REPLAY_NOT_REPRODUCIBLE`, whose `data.reason` carries the same value.
The reasons are checked in their listed order, and the first that holds is the one
given, so it names the same reason the error would. Every finding of a `stateful`
analysis is `stateful`, confirmed or not. Whether the trace holds the finding's
request is decided when the run is stored, against the trace as it is stored, and
kept with the version of the matcher that decided it. Storing a run whose trace
does not read back from its own bytes fails, rather than keep a run no replay could
read; a `flaky` or `unverified` finding,
which has no minimal payload, is looked up as its replay sends it: the first
recorded request that broke an invariant at its endpoint, in its phase, under its
identity and with its status.

`replay_alone` is `null` for a finding that nothing else refuses and that was
stored before protocol `0.2.2`, or by a core whose matcher had another version:
whether its request is in the trace is not known until it is replayed. `stateful`, `refuted` and `trace_pruned` are still given for it.

!!! note "`possible: true` is not a promise"
    `replay_alone` does not cover what depends on the replay call itself or on the
    live secrets. A finding it calls replayable can still be refused for the
    consent its analysis's recording needs (`SIDE_EFFECTS_CONSENT_REQUIRED`), for a
    missing identity or credential, a stripped URL userinfo or another host
    (`REPLAY_NOT_REPRODUCIBLE`), and when the trace's file is missing or fails its
    integrity check. A client disables "replay alone" on `possible: false`, and
    still handles those errors when it is pressed.
