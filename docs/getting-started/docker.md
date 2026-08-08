# Docker Compose

The root `docker-compose.yml` is the entry point for running Spec Forge in
containers. It groups services into profiles, so only the requested workload
starts.

## CLI (`dev` profile)

```bash
poe dev
```

## Demo API (`demo` profile)

Start the dummy API used for manual or demo fuzzing:

```bash
poe demo
```

## Working on one module

Module-specific Compose files under `lib/*` remain available when you need to
work within a package directly. Test and lint commands, including the repository
`test` profile, are documented in [Development & Testing](development.md).
