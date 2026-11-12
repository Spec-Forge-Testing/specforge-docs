# Protocol errors

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
| -32000 | `PROTOCOL_VERSION_MISMATCH` | `data`: `expected` (the core's version), `oldest` (the floor it serves from), `received`; see [versioning](handshake.md#versioning) |
| -32000 | `NO_ACTIVE_PROJECT` | The operation needs an open project and there is none |
| -32000 | `PROJECT_SWITCH_REJECTED` | `data`: `operations`, the list of what is still alive |

The −32000…−32099 range is the "server error" range the standard leaves
implementation-defined. A domain error below rides `-32000` and adds its own
`data.code`, except six that refuse the request's parameters as given and so
ride `-32602`, the integer of `INVALID_PARAMS`:

| `data.code` | Why it is a parameter refusal |
| --- | --- |
| `UNKNOWN_CONFIG_KEY` | The key named is not an option |
| `CONFIG_READ_ONLY` | The key named cannot be written |
| `INFERENCE_APPROVAL_REQUIRED` | The `producer.approval_token` is missing or stale |
| `SIDE_EFFECTS_CONSENT_REQUIRED` | The call lacks `allow_side_effects` |
| `PRUNE_PLAN_STALE` | The plan passed differs from what is stored |
| `REQUIREMENT_UNMET` | The run lacks what its mode requires; `data.parameter` names what supplies it ([below](#requirement-unmet)) |

A frontend branches on `data.code` either way; the integer only tells a generic
JSON-RPC client which class of failure it is.

### `INVALID_PARAMS` for a base URL { #base-url-invalid-params }

A run's or a replay's `base_url` is refused `INVALID_PARAMS` before any request
is sent unless it is an `http` or `https` URL that names a host, writes any port
from 1 to 65535, and carries no query and no fragment, not even a bare `?` or
`#`. `data.reason` says what was wrong and never repeats the URL, since it may
carry userinfo. A URL with a query never reached its target as written: the
route was appended after the query, inside it. See
[the target base URL](operations.md#base-url).

### `INVALID_PARAMS` from configuration { #config-invalid-params }

A configuration value of the wrong type or outside its range is refused
`INVALID_PARAMS` with `data`: `key` (the option), `expected` (its type or
range), and `reason`. When the value came from the project's `specforge.toml`
rather than the request, `data` also carries `source: "specforge.toml"`. That
check runs on `get_config`, `set_config`, `fuzz`, `run_pipeline` and `replay`;
`reset_config` never checks, and is the way out of a bad file value.

### `INVALID_PARAMS` from the producer { #producer-invalid-params }

An `inference` producer without `source_repo` is refused `INVALID_PARAMS` with
`data.parameter` `producer.source_repo`, so a client can mark the field. A run
with `producer.max_cost_usd` whose pending inferences have no price on some model
of the chain, the primary or a fallback, is refused `INVALID_PARAMS` before any
inference: a cap cannot hold a worst case it cannot price (see
[the cap](../inference.md#the-cap)). Its `data` carries `parameter`, the cap
the operation was given and the field to mark, and `model`, the model with no
price; its message names that model. `parameter` is `producer.max_cost_usd` on
`fuzz`, `run_pipeline` and `estimate_inference`, and `max_cost_usd` on a
`generate_contract` with `use_llm`, which is refused before its route discovery is
sent ([its cap](operations.md#generate-contract-cap)). The estimate's
[`unpriced_models`](operations.md#estimate-inference) names the same models
before the run is sent.

```json
"data":{"code":"INVALID_PARAMS","parameter":"producer.max_cost_usd","model":"…"}
```

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
| `CONTRACT_GENERATION_FAILED` | `generate_contract` reached its work and could not finish it: `repo_root` is not a directory, or no route was found in it. `data`: `path`, `reason` |

### Analysis

| `data.code` | When |
| --- | --- |
| `NO_STATIC_ANALYSIS` | An operation that `requires` `analysis` was called before any `analyze_endpoints` in this session |
| `ENDPOINT_NOT_ANALYZED` | The endpoint has no static analysis yet |
| `ENDPOINT_ANALYSIS_FAILED` | Static analysis of the endpoint failed |
| `REPO_ROOT_INVALID` | The repository to trace does not exist or is not a directory |
| `STATIC_ANALYSIS_REQUIRED` | A finding's handler code was needed and could not be reached: its run traced no tree, or tracing its endpoint there found no handler |

#### Why an endpoint could not be resolved { #analysis-failure-reasons }

When static analysis cannot resolve an endpoint, the core publishes a closed `code`
and a `reason`: an English sentence it writes for that code, naming the endpoint and
what the code knows. The same pair travels in the `endpoint_failed` event, in
`analyze_endpoints`' `failures`, in `ENDPOINT_ANALYSIS_FAILED` and
`STATIC_ANALYSIS_REQUIRED` (`data.reason` and the message), and in
`estimate_inference`'s `untraced`. Branch on `code`; show `reason` as it comes.

| `code` | `reason`, for `GET /articles` |
| --- | --- |
| `CONTROLLER_NOT_FOUND` | No file in the scanned repository declares GET /articles. |
| `FRAMEWORK_ROUTE` | No file declares GET /articles: the framework publishes that route by itself. |
| `AMBIGUOUS_CONTROLLER` | More than one file declares GET /articles: a.py, b.py. |
| `HANDLER_NOT_FOUND` | a.py declares GET /articles, but the function that handles it could not be named. |
| `TARGET_NODE_NOT_FOUND` | The function get_article, behind GET /articles, was not found in a.py. |
| `UNSUPPORTED_LANGUAGE` | The code behind GET /articles is in a .rs file (a.rs), a language the analysis does not read. |
| `SYNTAX_PARSE_ERROR` | a.py, which holds the code behind GET /articles, could not be parsed. |
| `SOURCE_UNREADABLE` | a.py, which holds the code behind GET /articles, could not be read. |

File paths are written as the analysis found them, with the separator of the
machine the core runs on. `UNSUPPORTED_LANGUAGE` leaves out the file in brackets
when the analysis named none.

### Execution

| `data.code` | When |
| --- | --- |
| `NO_BASE_URL` | A run was asked for with no target base URL |
| `IDENTITIES_INVALID` | The declared identities are malformed |
| `UNSUPPORTED_SCHEMA` | The contract's schema version is not supported |
| `NO_COMPILABLE_ENDPOINTS` | No endpoint could be compiled into a strategy |
| `CONTRACT_PRODUCER_FAILED` | A contract producer could not honor an explicit request. A `producer.source_repo` that is not a directory is one, on `fuzz` and `estimate_inference` and in `run_pipeline`'s `inference` stage, before any inference: `data.source` names the path and `data.detail` is `not a directory`. A capped `generate_contract` whose route discovery its `max_cost_usd` cannot hold is another, before the discovery call the cap cannot hold is sent and with nothing written: `data.source` is `route discovery` and `data.detail` the reason ([its cap](operations.md#generate-contract-cap)) |
| `INFERENCE_APPROVAL_REQUIRED` | A run has inferences to pay for while `inference.require_approval` is on, and its `producer.approval_token` is missing or stale; `data`: `reason` (`missing` or `stale`), `estimate` (as [`estimate_inference`](operations.md#estimate-inference) answers it). Refused before any inference; in `run_pipeline` it fails the `inference` stage with the same code and `data` |
| `REQUIREMENT_UNMET` | The run's mode requires what the request lacks; refused before anything is traced, produced or sent ([details](#requirement-unmet)) |
| `NOTHING_VERIFIED` | The run would verify no endpoint: an `auth` run that can cross nothing, or a run whose every endpoint the safety guard holds back ([details](#nothing-verified)) |
| `EXECUTION_FAILED` | The run failed while executing |
| `REBUILD_FAILED` | The API under test could not be built and started again before its replay, so the replay was not sent |
| `REPLAY_NOT_REPRODUCIBLE` | The recorded trace cannot be replayed against the target; also a `replay_finding` or `verify_finding_fix` of a finding that cannot be sent alone: a stateful one recorded without the steps of its minimal sequence, or unconfirmed (its `reason` says to replay the analysis instead), a `refuted` one, which is not a defect, one whose trace was pruned, or one whose request is not in the trace. For those four, `data.reason` is the refusal (`stateful`, `refuted`, `trace_pruned` or `not_in_trace`), as each finding's [`replay_alone`](run-detail.md#replay-alone) announces it ahead; every other cause carries no `reason` |
| `SIDE_EFFECTS_CONSENT_REQUIRED` | A `replay`, `replay_finding` or `verify_finding_fix` of a recording that needs [consent](operations.md#replay-consent) did not pass `allow_side_effects`; refused before any request is sent. `data`: `analysis_id`, `parameter` (`allow_side_effects`), `reasons` (every case that applies, most severe first: `safety_breached`, then `recorded_with_side_effects`) and `reason` (the first of `reasons`) |

#### `REQUIREMENT_UNMET` { #requirement-unmet }

A `fuzz` or `run_pipeline` whose run takes a variant that
[`requires`](fuzz-options.md#which-variant) what the request lacks is refused
before its tree is traced, its contracts produced or anything sent, so no
inference is paid for. `data.requirement` is the first value of `requires` the
run does not meet, and `data.parameter` the parameter that meets it: a client
marks that field.

| `data.requirement` | `data.parameter` | What meets it |
| --- | --- | --- |
| `identities` | `identities_path` | An identities file declaring at least one identity the target should accept |
| `access_policies` | `producer` | A producer whose contracts declare access policies, `fixture` or `inference` |

```json
"data":{"code":"REQUIREMENT_UNMET","requirement":"access_policies","parameter":"producer"}
```

#### `NOTHING_VERIFIED` { #nothing-verified }

A run whose contracts are produced and whose engine would verify no endpoint is
refused rather than reported `completed`. `data.cause` says why;
`data.endpoints` lists each endpoint as `{endpoint_id, reason}`; `data.parameter`
names the parameter that lifts it, when one does. Inferred contracts stay in the
cache, so asking again does not pay for them again
([ADR-213](../adr/core.md#adr-213)).

| `data.cause` | When | Each endpoint's `reason` | `data.parameter` |
| --- | --- | --- | --- |
| `access_uncrossable` | An `auth` run crossed no endpoint: none that is not public declares an access policy, or none it declares can be crossed | Its [`unprobed_reason`](vocabularies.md#unprobed-reason) | absent: a producer whose contracts declare crossable policies lifts it |
| `held_back` | The safety guard holds back every endpoint of the run; nothing is sent | Its `hold_reason` | `allow_side_effects` |

`vocabulary.nothing_verified_causes` carries each cause with its label.

### Results and retention

| `data.code` | When |
| --- | --- |
| `ANALYSIS_NOT_FOUND` | The requested analysis does not exist |
| `STORED_PROJECT_NOT_FOUND` | The requested stored project does not exist |
| `RUN_NOT_FOUND` | The requested run does not exist |
| `FINDING_NOT_FOUND` | The requested finding does not exist |
| `RESULTS_READ_FAILED` | Reading stored results failed |
| `PRUNE_FAILED` | Building a prune plan failed |
| `PRUNE_PLAN_STALE` | The prune plan differs from what is stored |
| `PRUNE_APPLY_FAILED` | Applying a prune plan failed |
| `FINDING_EXPLANATION_FAILED` | A finding needed a model to be explained and no usable explanation came back: no model could be asked, or the one asked failed |
| `FINDING_FIX_FAILED` | No fix could be proposed for a finding: no model could be asked, the one asked failed, or the fix could not be kept |
| `FIX_NOT_FOUND` | The finding has no proposed fix, or none with that id |
| `FIX_EMPTY_OR_UNAPPLICABLE` | The fix has nothing to apply: none of its edits held when it was proposed |
| `FIX_APPLY_FAILED` | Applying a fix failed for a reason other than a conflict, such as `git` failing after its check passed or a file that could not be backed up or written. The tree is left as it was |

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
