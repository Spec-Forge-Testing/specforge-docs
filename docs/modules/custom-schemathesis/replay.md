# Replay

Replay is the second half of reproducibility-by-record-and-replay (not by seed):
a recorded run's trace is **re-sent verbatim** — nothing is generated and nothing
is shrunk — to put the API back in the same context an earlier run created, and to
measure whether its responses still land there.

It is a third registered `ExecutionMode` (`REPLAY`), added next to stateless and
stateful **without touching the engine core** — the first real exercise of the
mode registry. Its options travel through `RunRequest.options`; a replay ignores
`engine_input` entirely, consuming only the trace and the config.

```python
run(EngineInput(), config,
    mode=ExecutionMode.REPLAY,
    options=ReplayOptions(trace=recorded_trace))
```

## Fidelity is measured by response divergence, not by trace hashes

A replay re-emits exactly the requests it read, so its re-recorded trace is
stimulus-identical by construction — comparing trace hashes would prove nothing.
What matters is whether the *responses* still land in the same context, which each
recorded request's status code (and whether it was itself a finding) makes
observable:

| Observed divergence | Fidelity |
| -- | -- |
| none | exact |
| only on requests that were already findings | exact — re-seeing the finding is the measurement, not a loss |
| on a request that was previously clean | reduced — the surrounding context changed |

The second row is the point: if the only request that now behaves differently is
the one that used to fail, that is the fix you were looking for, not a loss of
fidelity. The third row is the honest **stateful** limitation — a
`create → read-by-id` flow usually diverges on replay because the new resource
gets a new id, so a stateful replay typically reports reduced fidelity. That is
not a failure; it still reproduces the exact stimulus for investigation.

## Credentials and environments

Credentials are omitted from the trace by origin: only the **names** of
config-sourced headers are recorded, never their values. The replay re-injects
them from the current config, matched case-insensitively. Consequently, replaying
against another environment (staging vs production) is a config change, not a file
edit — and a config header the trace referenced but the current config lacks is a
hard error, never a silently degraded request.

Identities are never persisted either: only the **label** each request was built
under travels with the trace and, when one triggered a finding, with the crash
report — the identity's credentials never do. A replay re-supplies the values live,
from the identities passed to it. `rehydrate_request` resolves each traced
request's identity by label against the ones it was given and merges its headers
in the same layer a live run would; a label the trace recorded that the replay was
not given raises `EngineError` — the exact request cannot be rebuilt without it.
The CLI turns that into a pre-flight instead: it refuses the whole replay, naming
every missing label, before a single request goes out (see the `replay` command
in [core commands](../core/commands.md)).

A URL's `user:pass@` userinfo is omitted the same way, by origin rather than
redaction: the trace keeps the recorded URL with its userinfo stripped, plus
`TracedRequest.omitted_url_userinfo`, so a request that never had one stays
distinguishable from one that did. Rehydration re-injects it from the live
`ExecutionConfig.base_url` and refuses — again `EngineError` — when that URL
carries none, or when it targets a different host than the one recorded: a
credential is bound to the host it was issued for, not to whichever host a
replay happens to target. The CLI exposes this as `--base-url <url>`, which
may only re-supply the credential for the target the trace was already
recorded against — a replay never retargets a recorded request to a
different host.

## What a replay evaluates

Without the compiled endpoints, a replay can only re-flag the contract-free
invariant — a `5xx` — which is what feeds its `findings_raw`. It deliberately does
not re-detect response-contract findings (declared status / content-type / schema),
because it does not carry the contracts that define them.

## Pacing is forward-only

The replay reproduces *when* each request fired, measured from its own start, and
never compresses to catch up: if the API answered slower than in the original run,
the replay stays behind rather than bursting, which would create a concurrency the
original run never had. `preserve_timing=False` disables the waiting for debugging.
