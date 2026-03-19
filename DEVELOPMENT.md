# Development

## Prerequisites

- Node.js 22 or newer is the current development baseline.
- Docker is the simplest way to run the MySQL and Postgres fixtures used by the full test suite.

## Local setup

```sh
npm ci
docker compose up -d mysql-dev postgres-dev
npm run ci:setup-db
```

SQLite fixture databases are committed in the repo as `mydb.db` and `users.db`. The setup script only resets MySQL and Postgres.

## Common commands

```sh
npm run build
npm test
npm run test:rescript
npm run pack:dry-run
```

## CI parity

GitHub Actions uses the same `npm run ci:setup-db` bootstrap script before running the suite. If CI fails on relational tests, reproduce locally by re-running the database setup step before `npm test`.

## Release flow

Publishing is handled by `.github/workflows/publish.yml` through npm trusted publishing. The workflow rebuilds, reseeds the relational fixtures, runs the full test suite, and only then publishes the package.
