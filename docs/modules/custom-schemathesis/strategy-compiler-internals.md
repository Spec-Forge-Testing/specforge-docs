# Strategy compiler internals

This page is the file-by-file map of `strategy_compiler/schema_compiler/` —
the part of the [strategy compiler](reference.md#strategy-compiler) that turns
a single contract field into a concrete Hypothesis strategy. The
[complete reference](reference.md) covers the compiler's public entry point
and extension mechanism; this page covers what's inside `default/` and
`hacker/`.

## Layout

```
schema_compiler/
  __init__.py         ContractCompiler Protocol, _REGISTRY, compile_contract, register_compiler
  default/
    compiler.py        DefaultContractCompiler (valid / boundary / invalid; attack falls back to valid)
    phases.py           build_valid_strategy, build_boundary_strategy, build_invalid_strategy
    type_strategies.py  valid_for_type, string_strategy, array_strategy, object_strategy, compile_for_phase
    constraints.py      INT_BOUNDARY, FLOAT_BOUNDARY and shared numeric helpers
  hacker/
    compiler.py         HackerContractCompiler (delegates to default for non-attack phases)
    builders.py         build_attack_payloads, _encode_variants, mutate_object
    tables.py           per-attack-vector string tables (data only)
```

`default/` has no knowledge of `HackerStrategyContract` or `hacker/`; the
dependency runs one way — `hacker/` builds on top of `default/`, never the
reverse.

## `default/compiler.py` — `DefaultContractCompiler`

Dispatches by phase to the builders in `phases.py`. The `attack` phase falls
back silently to `build_valid_strategy`: `BaseStrategyContract` has no
offensive knobs to drive it.

## `default/phases.py` — builders per phase

- **`build_valid_strategy`** — correct values: `const` → `st.just`, `enum` →
  `st.sampled_from`, a known type → `valid_for_type`, no type →
  `fallback_from_jsonschema`. Wrapped in `st.one_of(st.none(), base)` when
  `nullable=True`.
- **`build_boundary_strategy`** — domain edges: for `integer`, candidates from
  `integer_boundary_values(min, max)` filtered by `boundary_int_filter`; for
  `string`, values at `minLength`/`maxLength` and their neighbors; for
  `array`/`object`, delegates recursively with `phase="boundary"`.
- **`build_invalid_strategy`** — wrong types and out-of-range values:
  `st.text()`/`st.none()` for numeric fields, `st.integers()`/`st.booleans()`
  for strings, and `integer_attack_values()` entries that fall outside the
  declared range.

## `default/type_strategies.py` — builders per JSON Schema type

- **`valid_for_type(t, data, contract)`** — dispatches by JSON Schema type to
  the builders below.
- **`string_strategy`** — picks a known-format regex (`FORMAT_PATTERNS`:
  `email`, `uuid`, `date`, `date-time`, `uri`, `ipv4`, `hostname`, `byte`), a
  custom regex (`pattern`), or plain `st.text`.
- **`array_strategy`** — `st.lists(compile_for_phase(items, phase), min_size,
  max_size)`.
- **`object_strategy`** — `st.fixed_dictionaries(required={...},
  optional={...})`, built recursively from `contract.properties`.
- **`compile_for_phase(contract, phase)`** — the recursive dispatcher for
  nested contracts. Imports `phases.py` lazily to break the circular
  dependency `phases → type_strategies → phases`.
- **`strategy_from_jsonschema`** — a patchable attribute pointing at
  `hypothesis_jsonschema.from_schema` when installed, or `None`. Used by
  `fallback_from_jsonschema` for constructs the native builders don't cover
  (`anyOf`, `oneOf`, `$ref`, unknown `format`).

## `default/constraints.py` — shared numeric data

Pure tables and helpers, no Hypothesis imports. Used by both `default/` and
`hacker/`.

- `INT_BOUNDARY`, `FLOAT_BOUNDARY` — extreme and boundary values per numeric
  type.
- `integer_boundary_values(min, max)`, `number_boundary_values(min, max)` —
  enrich the base tables with the edges of the declared range.
- `integer_attack_values()`, `number_attack_values()` — subsets used by the
  `attack` phase.
- `resolve_min_int`, `resolve_max_int`, `resolve_min_float`,
  `resolve_max_float` — normalize `minimum`/`exclusiveMinimum` into a
  concrete value.
- `multiple_of_filter`, `boundary_int_filter`, `is_out_of_range` —
  predicates used as `.filter()` calls or for manual candidate selection.

## `hacker/compiler.py` — `HackerContractCompiler`

Composes over `DefaultContractCompiler`: delegates every phase except
`attack`. For `attack`, calls `_build_attack(contract)`, which pulls the
offensive knobs off the contract and calls `build_attack_payloads`.

## `hacker/builders.py` — payload construction

- **`build_attack_payloads(value_type, profiles, *, include_encoded_variants,
  include_nulls, include_large_values, minimum, maximum)`** — dispatches by
  type:
    - `string`: takes `PROFILE_STRING_PAYLOADS[profile]` per declared profile
      (or `GENERIC_STRING_PAYLOADS` if none declared), optionally expanded
      with `_encode_variants` (original + URL-encoded + Base64); adds
      nullbytes when `include_nulls`.
    - `integer`/`number`: `integer_attack_values()` plus
      `integer_boundary_values(min, max)` from `default/constraints.py`;
      `None` when `include_nulls`.
    - `boolean`: a fixed list that mixes types on purpose (`True`, `False`,
      `None`, `0`, `1`, `"true"`, `"false"`, `"null"`).
    - `array`/`object`: lists/dicts carrying prototype-pollution, overflow,
      and null mutations.
    - Returns `st.sampled_from(unique)` after deduplicating; `st.none()` if
      the list ends up empty.
- **`_encode_variants(payload)`** — expands a string into
  `[original, URL-encoded, Base64]`.
- **`mutate_object(obj, depth)`** — applies prototype pollution, overflow,
  and extra fields; recurses up to `depth`.

## `hacker/tables.py` — pure data

Twelve string tables, one per attack vector: `_SQL`, `_XSS`,
`_PATH_TRAVERSAL`, `_SSRF`, `_AUTH_BYPASS`, `_INPUT_VALIDATION`,
`_DESERIALIZATION`, `_PARSER_COMPAT`, `_HEADERS_COOKIE`,
`_INFO_DISCLOSURE`, `_RESOURCE_ABUSE`, `_BUSINESS_LOGIC`.

- `PROFILE_STRING_PAYLOADS` — profile name → string list.
- `GENERIC_STRING_PAYLOADS` — fixed subset used when no profile is declared.

No Hypothesis imports, no heavy stdlib dependency.
