# Stateful fuzzing

Stateful mode tests dependent endpoint sequences while keeping stateless fuzzing
unchanged for endpoints that declare no state links.

## Declarative links

`StateLinkContract` describes three things:

- **Production:** a response field stored in a named state bundle.
- **Consumption:** a stored value reinjected into a request zone.
- **Invariant:** a condition checked after a state transition.

The compiler carries this optional contract into `CompiledExecutionEndpoint`. The
stateful fuzzer consumes it; the normal async fuzzer ignores it.

## Execution model

The engine executes generated chains, carries state between requests and reports a
transition sequence with any cross-endpoint finding. Shrinking remains sequential to
avoid interference from shared state, rate limits and side effects.

Detailed lifecycle, configuration and invariants remain in the
[complete reference](reference.md#stateful-fuzzing).
