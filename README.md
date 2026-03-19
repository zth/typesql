# rescript-typesql

> `rescript-typesql` is a long-term fork of `typesql` that is being steered toward a ReScript-first workflow.

## What it does

- Generates typed query helpers from raw SQL.
- Supports direct ReScript generation from SQL strings.
- Supports embedded-query workflows for ReScript projects.
- Keeps SQL as the source of truth instead of pushing you into an ORM DSL.
- Infers parameter types, result types, nullability, nested result structure, and dynamic query metadata.

## Supported database clients

- PostgreSQL via `pg`
- MySQL via `mysql2`
- SQLite via `better-sqlite3`
- SQLite-compatible libSQL via `libsql`
- SQLite-compatible D1 via `d1`
- SQLite via `bun:sqlite`

## Install

Install it as a project dependency and run the CLI through `npx`:

```sh
npm install --save-dev rescript-typesql
```

The package installs the `typesql` binary:

```sh
npx typesql --help
```

If you are using the embedded ReScript flow, you will usually also want:

```sh
npm install --save-dev rescript rescript-embed-lang
```

## Quick start

Create a `typesql.json` file:

```json
{
	"databaseUri": "./mydb.db",
	"sqlDir": "./sql",
	"client": "better-sqlite3",
	"includeCrudTables": [],
	"rescript": {
		"srcDir": "./src",
		"outDir": "./src/__generated__"
	}
}
```

Configuration notes:

- `client` can be `pg`, `mysql2`, `better-sqlite3`, `libsql`, `bun:sqlite`, or `d1`.
- `authToken` is used only for `libsql`.
- `schemas` is optional for Postgres and defaults to `["public"]`.
- `databaseUri` and `authToken` support `${ENV_VAR}` substitution.
- Use `--env-file .env` to load env vars before config resolution.

Add some SQL:

```sql
SELECT
  id,
  name
FROM users
WHERE id = :id
```

Then either generate TypeScript files beside your SQL:

```sh
npx typesql compile --config ./typesql.json
```

Or generate ReScript for a single query directly:

```sh
npx typesql rescript generate --config ./typesql.json --name selectUser --sql "select id, name from users where id = :id"
```

## ReScript workflow

The ReScript command family is the part of the project that this fork is optimizing for.

Core commands:

- `typesql rescript generate` generates ReScript for a single SQL string.
- `typesql rescript check` returns the expected variable shape for a query.
- `typesql rescript inspect` resolves executable SQL and bind values.
- `typesql rescript explain` runs `EXPLAIN` or `EXPLAIN ANALYZE` for a resolved query.
- `typesql rescript exec` executes a query with explicit variables.
- `typesql rescript sync` extracts `%generated.typesql` embeds and writes `__typesql.res` files.
- `typesql rescript watch` keeps generated embed files in sync while you edit.
- `typesql rescript daemon` starts a long-lived process for editor or tooling integrations.

Generate from stdin:

```sh
echo "select id, name from users where id = :id" | npx typesql rescript generate --config ./typesql.json --name selectUser
```

Inspect resolved SQL:

```sh
npx typesql rescript inspect --config ./typesql.json --name selectUser --sql "select id, name from users where id = :id" --vars '{"id":1}'
```

Sync embedded queries:

```sh
npx typesql rescript sync --config ./typesql.json
```

Watch embedded queries:

```sh
npx typesql rescript watch --config ./typesql.json
```

## TypeScript generation

The legacy `compile` flow remains available and still generates `.ts` files from `.sql` files:

```sh
npx typesql compile --config ./typesql.json
npx typesql compile --watch --config ./typesql.json
```

This is still useful for compatibility and as an intermediate representation, but it is not the long-term product focus of this fork.

## Notable behavior

- Raw SQL stays the source of truth.
- Nullability is inferred from query structure when possible.
- Unique-key and `LIMIT 1` cases can narrow result cardinality.
- Dynamic query support includes typed `ORDER BY` and list expansion.
- SQLite ReScript generation caches static prepared statements per database instance.

## Project direction

- This fork is intended to diverge from upstream.
- ReScript support is the strategic focus.
- TypeScript support can change if that is what the ReScript path needs.
- Expect active iteration rather than strict compatibility guarantees.

## Development

Development notes and local CI setup live in [`DEVELOPMENT.md`](https://github.com/zth/typesql/blob/main/DEVELOPMENT.md).

## Additional docs

- [Query scaffolding](https://github.com/zth/typesql/blob/main/docs/query_scaffolding.md)
- [INSERT](https://github.com/zth/typesql/blob/main/docs/insert.md)
- [IN / NOT IN](https://github.com/zth/typesql/blob/main/docs/in_clause.md)
- [MySQL functions](https://github.com/zth/typesql/blob/main/docs/functions.md)
- [ORDER BY and LIMIT](https://github.com/zth/typesql/blob/main/docs/orderBy_limit.md)
- [LIKE](https://github.com/zth/typesql/blob/main/docs/like.md)
- [Nested query results](https://github.com/zth/typesql/blob/main/docs/nested-query-result.md)
