# Errors

JSON-RPC's `code`s are integers with a range reserved for the protocol, so they
are no use for the domain. The **stable domain code is a string** and travels in
`error.data.code`, alongside the typed details. **The frontend triggers behavior
off that code, never by parsing `message`** — `message` is for display and can
change between versions; the code does not.

```json
{"jsonrpc":"2.0","id":4,"error":{
  "code":-32000,
  "message":"Can't switch projects with operations in progress",
  "data":{"code":"PROJECT_SWITCH_REJECTED","operations":[{"id":2,"method":"fuzz"}]}
}}
```

**Every error carries `data.code`, no exceptions** — parse errors included. The
core is the sole authority that rejects: a frontend *should* pre-validate the
syntactic parts it reads from the catalog (a missing flag, an out-of-enum value)
to flag an obvious mistake while typing, but it never implements its own rules
or pre-checks state — it acts and handles the rejection.

Each domain class owns both its integer and its string, and builds its own
`error` object — the transport decides nothing. The same registry backs the
machine-readable error codes any other surface enumerates, so the two never
disagree. `describe` publishes the complete set (`error_codes`) so a frontend
can handle them exhaustively rather than discover one at a time.

## Protocol-level codes

Nine codes ride the JSON-RPC integers directly:

| `error.code` | `data.code` | When |
| ---: | --- | --- |
| -32700 | `PARSE_ERROR` | The line is not valid JSON |
| -32600 | `INVALID_REQUEST` | Not a valid JSON-RPC 2.0 message, or a batch |
| -32601 | `UNKNOWN_OPERATION` | `method` is not in the catalog |
| -32602 | `INVALID_PARAMS` | Missing parameter, wrong type, out-of-range enum, repeated token |
| -32603 | `INTERNAL_ERROR` | Unforeseen failure; the traceback goes to stderr |
| -32000 | `HANDSHAKE_REQUIRED` | An operation before `hello` |
| -32000 | `PROTOCOL_VERSION_MISMATCH` | `data`: `expected`, `received` |
| -32000 | `NO_ACTIVE_PROJECT` | The operation needs an open project and there is none |
| -32000 | `PROJECT_SWITCH_REJECTED` | `data`: `operations`, the list of what is still alive |

The −32000…−32099 range is the "server error" range the standard leaves
implementation-defined; every domain error below rides that same integer and
adds its own `data.code`.

## The domain codes

Beyond the nine above, the core answers with a stable `data.code` for every
domain failure a service can raise. They fall into the operation families that
raise them. Together with the protocol-level codes, these are the complete set.

### Session and workspace

| `data.code` | When |
| --- | --- |
| `PROJECT_NOT_FOUND` | The named project does not exist on disk |
| `WORKSPACE_INIT_FAILED` | Creating a project's `.specforge` / `specforge.toml` failed |
| `SESSION_ERROR` | A session-level failure with no more specific code |

### Contract

| `data.code` | When |
| --- | --- |
| `NO_CONTRACT_LOADED` | The operation needs a loaded contract and none is |
| `CONTRACT_LOAD_FAILED` | The contract could not be parsed or loaded |
| `UNKNOWN_ENDPOINT` | The referenced endpoint is not in the contract |
| `NO_MATCHING_ENDPOINTS` | A selection matched no endpoint |

### Analysis

| `data.code` | When |
| --- | --- |
| `NO_STATIC_ANALYSIS` | No static analysis has been run for this project |
| `ENDPOINT_NOT_ANALYZED` | The endpoint has no static analysis yet |
| `ENDPOINT_ANALYSIS_FAILED` | Static analysis of the endpoint failed |

### Execution

| `data.code` | When |
| --- | --- |
| `NO_BASE_URL` | A run was asked for with no target base URL |
| `IDENTITIES_INVALID` | The declared identities are malformed |
| `UNSUPPORTED_SCHEMA` | The contract's schema version is not supported |
| `NO_COMPILABLE_ENDPOINTS` | No endpoint could be compiled into a strategy |
| `CONTRACT_PRODUCER_FAILED` | A contract producer could not honor an explicit request |
| `EXECUTION_FAILED` | The run failed while executing |
| `REPLAY_NOT_REPRODUCIBLE` | The recorded trace cannot be replayed against the target |

### Results and retention

| `data.code` | When |
| --- | --- |
| `ANALYSIS_NOT_FOUND` | The requested analysis does not exist |
| `STORED_PROJECT_NOT_FOUND` | The requested stored project does not exist |
| `RUN_NOT_FOUND` | The requested run does not exist |
| `FINDING_NOT_FOUND` | The requested finding does not exist |
| `RESULTS_READ_FAILED` | Reading stored results failed |
| `PRUNE_FAILED` | Building a prune plan failed |
| `PRUNE_PLAN_STALE` | The prune plan no longer matches what is stored |
| `PRUNE_APPLY_FAILED` | Applying a prune plan failed |

### Config and environment

| `data.code` | When |
| --- | --- |
| `UNKNOWN_CONFIG_KEY` | The configuration key is not recognized |
| `CONFIG_READ_ONLY` | The configuration key cannot be written |
| `PROTOCOL_FIXES_DISABLED` | An environment fix was requested while fixes are disabled |
| `REPOSITORY_ROOT_NOT_FOUND` | The repository root could not be located |

### Cross-cutting

| `data.code` | When |
| --- | --- |
| `OPERATION_FAILED` | A generic operation failure with no more specific code |
| `DEPENDENCY_UNAVAILABLE` | An optional library the operation needs is not installed |
