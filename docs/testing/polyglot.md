# Polyglot corpus (reserved, not yet built)

The third corpus slot, and the only one of the three not implemented yet.
[RealWorld](real-world.md) covers all 12 languages but with one synthetic
contract (Conduit), built as a demo, not a source of real bugs. [EMB](emb.md)
measures real bug detection but is entirely JVM. Neither answers "_does Spec
Forge find real bugs in real code outside the JVM?_" — that's the question
`polyglot` exists for: **one real open-source API per `core_ast`-supported
language**, chosen for a real OpenAPI contract and active maintenance rather
than for matching a shared contract like RealWorld does.

## Status

Not implemented. What exists today is the candidate research: one real
candidate per language, its license, and how it exposes OpenAPI. The
implementation itself is a separate, currently unscoped effort — repeating
`real-world/`'s infrastructure across 11 languages is expensive (see
[EMB → Why the upstream isn't committed](emb.md#why-the-upstream-isnt-committed)
for what that cost looked like the first time), and it was deliberately not
started while `contract_engine` still had failing tests. Check the AI-property-based-testing
Linear team for current status before assuming this table is still accurate
or that work has started.

## Candidates by language

One real API per language, with a published or derivable OpenAPI contract, a
compatible license, and active maintenance.

| Language | Candidate | License | OpenAPI mechanism |
| --- | --- | --- | --- |
| Python | [Mealie](https://github.com/mealie-recipes/mealie) | MIT | Native FastAPI `/docs` (`/openapi.json`) |
| JavaScript | [NodeBB](https://github.com/NodeBB/NodeBB) | GPL-3.0 | REST v3 API with an available OpenAPI spec |
| TypeScript | [Medusa](https://github.com/medusajs/medusa) | MIT | Native — publishes OpenAPI v3 |
| Go | [Gotify](https://github.com/gotify/server) | MIT | Native (`/docs` / `swagger.json`) |
| Java | [Keycloak](https://github.com/keycloak/keycloak) | Apache-2.0 | Native Quarkus `/q/openapi` |
| C# | [Jellyfin](https://github.com/jellyfin/jellyfin) | GPL-3.0 | Native Swashbuckle (`/api-docs/openapi.json`) |
| Ruby | [Mastodon](https://github.com/mastodon/mastodon) | AGPL-3.0 | Documented in-repo (REST spec) |
| PHP | [BookStack](https://github.com/BookStackApp/BookStack) | MIT | Native, at `/api/docs.json` |
| Rust | [Meilisearch](https://github.com/meilisearch/meilisearch) | MIT | Native via `utoipa` |
| Kotlin | [Komga](https://github.com/gotson/komga) | MIT | Native Springdoc (`/v3/api-docs`) |
| Swift | [Feather CMS](https://github.com/FeatherCMS/feather) | MIT | Native Vapor + `VaporToOpenAPI` |

Each was picked over alternatives specifically for maintenance activity —
avoiding a repeat of the archived-Debian, expired-GPG-key, unpinned-dependency
class of problems that made `real-world/` expensive to stand up the first
time.