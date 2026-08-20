# Stateful fuzzing

Stateful mode tests dependent endpoint sequences while keeping stateless fuzzing
unchanged for endpoints that declare no state links.

## Declarative links

`StateLinkContract` describes three things:

- **Production:** a response field stored in a named state bundle.
- **Consumption:** a stored value reinjected into a request zone.
- **Invariant:** a condition checked after a state transition. It may declare the
  triggering statuses it applies after, so an invariant that only holds once the
  resource was really created is not checked after a rejected attempt.

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

Detailed lifecycle, configuration and invariants remain in the
[complete reference](reference.md#stateful-fuzzing).
