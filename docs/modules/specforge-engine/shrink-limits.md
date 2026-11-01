# Shrink limits and the trace

Shrinking sends requests to a target that may be slow or stuck, so its cost is bounded
in requests and in time. This page lists those bounds, explains why the simplest draw
is repeatable, and gives the contract of the trace a run records. How a shrink searches
is on [Engine internals](engine-internals.md).

## Bounds { #bounds }

| Constant | Value | Bounds |
| --- | --- | --- |
| `SHRINK_REQUEST_BUDGET` | 500 | Wire requests a stateless shrink spends on one finding |
| `HELD_SHRINK_REQUEST_BUDGET` | 250 | A group's second representative, which holds the first cause |
| `STATEFUL_SHRINK_REQUEST_BUDGET` | 1 000 | Each of a stateful pass's two shrinks |
| `SHRINK_WALL_BUDGET_S` | 120 s | One shrink's search and its controls, each shrink with its own |
| `SHRINK_SEARCH_TIMEOUT_LIMIT` | 5 | Timed-out candidates a run's searches wait out at one endpoint |
| `CONTROL_SEND_CAP` | 10 | [Controls](control-requests.md#bounds) one finding sends |

These are stability guards, not settings, and live in `constants.py` modules.

### Per shrink: the wall budget

`WallBudget` starts when a shrink starts. Once it is spent, the search stops sending
and answers only from payloads it already saw fail, so the search can still end on its
smallest failure. If that minimum no longer reproduces, the shrink reports the raw
payload rather than losing the finding. In a stateful pass, the wall covers the
minimizer and the step's control together.

### Per endpoint: timed-out candidates

A search candidate that times out costs the whole request timeout, so one slow endpoint
could spend a whole run through its findings' shrinks. `SearchTimeouts` counts timed-out
candidates per endpoint across the run. Past the limit, every later search at that
endpoint stops sending. The count is kept in two parts:

- A timeout that **reproduces** the finding is progress, and counts apart. Only an
  `input_induced_timeout` search reads this count.
- A timeout that does not reproduce is only a wait. Every other search reads this one.

So waits caused by other findings never cut a timeout finding's search. A cut shrink
still judges and reports what it holds.

## The deterministic minimal draw { #minimal-draw }

The simplest payload of a strategy is the base of a valid pass, of its witnesses and of
a restored field. `minimal_draw_where` runs its search from a fixed seed
(`runtime/harness/minimal.py`), so the same strategy always gives the same payload,
within and across runs. Two functions extend this:

| Function | Stops |
| --- | --- |
| `simplest_draw_if` | at the strategy's first valid draw |
| `minimal_draw_within` | after a given number of judged candidates, those of its shrink included |

Requests stay random: only the minimal draw is fixed. Reproducibility of a run still
comes from recording and replay.

## The trace contract { #trace }

A run's `ExecutionTrace` holds the requests it put on the wire during exploration, in
send order. Search and control requests stay out, with one exception: the **tail**.

A report [reduced to the whole request](disclosure.md#scope) cites a request no
exploration sent: the counterfactual with the field restored. A replay must send it to
judge that report, so `build_trace_with_reduced_requests` appends it.

| Tail property | Behaviour |
| --- | --- |
| Position | After every exploration request |
| Duplicates | One per distinct endpoint, identity, status, path, query, headers and body |
| `sent_at_ms` | The last exploration request's offset, so a replay does not wait out the shrink |
| `total_requests` | Not counted; the send counts in `requests_shrink` |

A replay sends the whole trace, so its `requests_replayed` can exceed the recording's
exploration total. The tail exists only in stateless runs.
