# Docker Compose

The repository includes a root-level `docker-compose.yml` as the main entry point for the
monorepo. It groups services under profiles so you only start what you need.

## CLI (`dev` profile)

Run the main orchestrator:

```bash
poe dev
```

## Demo API (`demo` profile)

Start the dummy API used for manual/demo fuzzing runs:

```bash
poe demo
```

## Module test suites (`test` profile)

Each engine has its own service (`contract-engine`, `storage-engine`, `core-ast`, ...) that runs
`pytest` with coverage:

```bash
poe test
poe test-engine <engine-name>
# Example: poe test-engine storage-engine
```

The module-specific `docker-compose.yml` files under each `lib/*` package are still available if
you want to work inside a single package directly, without the root compose file.
