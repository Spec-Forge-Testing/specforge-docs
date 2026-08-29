# Custom Schemathesis — Stateful fuzzing

Stateful mode tests dependent endpoint sequences while keeping stateless fuzzing
unchanged for endpoints that declare no state links.

## Declarative links

`StateLinkContract` describes three things:

- **Production:** a response field stored in a named state bundle.
- **Consumption:** a stored value reinjected into a request zone.
- **Invariant:** a condition checked after a state transition. It applies after a
  trigger that took effect — any 2xx by default, or exactly the statuses it declares —
  so an invariant that only holds once the resource was really created is not checked
  after a rejected attempt.

The compiler carries this optional contract into `CompiledExecutionEndpoint`. The
stateful fuzzer consumes it; the normal async fuzzer ignores it.

## Execution model

The engine executes generated chains, carries state between requests and reports a
transition sequence with any cross-endpoint finding. A run stops at the first
broken invariant by default — cheap, one bug at a time — but can be configured to
keep searching for distinct bugs in the same run instead. In that mode an
already-reported defect stops the report, not the chain: the request still contributes
the state it declared, so the endpoints depending on it keep being exercised.

A state link that cannot be honored mid-run — a response missing the field a production
promised, a captured value that is unusable — stops the run rather than corrupting the
chain. It no longer discards what the run had already found: the confirmed defects come
back, and the trace records where the run stopped and why, so the report is a shorter
run rather than a lost one.

A target that stops answering is cut per endpoint, not per run. Each endpoint has a
circuit breaker: after `MAX_INFRA_FAILURES` consecutive transport failures it opens, and
that endpoint's rule returns without sending while every other rule keeps running. A
transition probe counts against the endpoint it probes. The trace says so:
`infrastructure_abort` names the first endpoint that opened while the run went on;
`target_down` means every rule endpoint the run reached opened, which the CLI reports as
an aborted run. A broken state link keeps its own `state_link_abort` even when a breaker
had opened first — the reason a run stopped is the reason that stopped it.

Detailed lifecycle, configuration and invariants remain in the
[complete reference](reference.md#stateful-fuzzing).
