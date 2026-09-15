# Contract Assembly — Decision records — Foundations

Part of the [Contract Assembly decision records](index.md). Package-wide
decisions: what the package is called and why.

---

## ADR-064 — The contract module is `contract_assembly` { #adr-064 }

**Status:** accepted · `pyproject.toml`, `exceptions.py`, `__init__.py`

### Context

The module was called "engine". The word described nothing it does: it ingests an
OpenAPI spec (parse, `$ref` resolution, Swagger 2.0 translation, tolerant
validation), adapts it into AST search coordinates, and fuses it with the
LLM-inferred contract into the unified contract. It *assembles* a contract from
those parts; it is not an engine of anything.

The name also collided twice. The pipeline already has an execution engine —
`specforge_engine`, which runs the property-based attack — and a shared kernel of
contract types, `specforge_contracts`. A reader meeting "contract engine" next to
"engine" and "contracts" cannot tell which package owns what, and the name gave no
hint that this one sits between the OpenAPI spec and the shared model.

### Decision

Four renames, applied together with no compatibility layer:

| Old | New |
| --- | --- |
| folder `lib/contract_engine` | `lib/contract_assembly` |
| import package `contract_engine` | `contract_assembly` |
| distribution `contract-engine` | `contract-assembly` |
| root exception `ContractEngineError` | `ContractAssemblyError` |

The internal subpackages — `ingestion/`, `adapters/`, `fusion/`, `models/` — keep
their names, and the public facade is unchanged: `parse_contract`, `ASTAdapter`,
`fuse_contract`, `ResolvedContract`, `EndpointDefinition`,
`UnifiedEndpointContract` all import from `contract_assembly` exactly as before.

No shims, no import aliases, no deprecated re-exports.

### Rejected

- **`contract_resolver`** — names only the ingestion stage (`$ref` resolution) and
  says nothing of adaptation or fusion, so it would mislead in the other direction.
- **`contract_forge`** — "forge" is the product's own name (Spec Forge); reusing it
  for one module blurs the whole for a part.
- **Keeping `contract_engine`** — or shipping an alias that re-exports it. Both
  preserve a name that describes nothing and collides with the execution engine and
  the kernel, and an alias would have to be maintained and then removed regardless.
  With no external consumers to protect, one clean rename costs less than a
  compatibility surface that would outlive its purpose.

### Consequences

Every consumer imports from `contract_assembly` and catches `ContractAssemblyError`;
the install line is `pip install -e lib/contract_assembly`; the CI job and test
matrix entry are named `contract_assembly`. The CLI's command category and the
`doctor` component both read **Contract Assembly**. The documentation section moved
from `modules/contract-engine/` to `modules/contract-assembly/` with no redirect.
