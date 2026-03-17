## TypeSQL

**TypeSQL** generates typesafe Typescript APIs from your SQL statements. Write your queries in raw SQL and TypeSQL generates the type-safe APIs to execute those queries.

Access your database directly without a heavy ORM, gain effortless type-safety, and make maintaining your SQL simple.

TypeSQL supports multiple SQL database backends:

##### PostgreSQL (Experimental)

- [pg](https://www.npmjs.com/package/pg) - PostgreSQL client for node.js.

##### MySQL

- [mysql2](https://www.npmjs.com/package/mysql2) - the standard driver for mysql in NodeJS

##### SQLite

- [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) - the fastest SQLite driver for NodeJS
- [bun:sqlite](https://bun.sh/docs/api/sqlite) - Bun's official high-performance SQLite driver

##### LibSQL

- [libsql](https://www.npmjs.com/package/libsql) - the NodeJS driver for libSQL, the open-source fork of SQLite powering [Turso](https://turso.tech/)

##### Cloudflare D1

- [@cloudflare/d1](https://developers.cloudflare.com/d1/) - Serverless SQLite-compatible database from Cloudflare.

## Example

Having the following query in `select-products.sql` file.

```sql
SELECT
  id,
  product_name,
  list_price
FROM products
WHERE discontinued = 0
  AND list_price BETWEEN :minPrice AND :maxPrice
```

TypeSQL will generate the types and function in the file `select-products.ts`.
Then you can import the generate code and execute as following:

deno syntax:

![](typesql-deno.gif)

## Some features:

- **Do not restrict the use of SQL** You dont need to learn any new query language, you can use SQL with all its power and expressiveness.

- **Infer parameters and columns types.** `SELECT DATEDIFF(:date1, :date2) as days_stayed` will resolve the `date1` and `date2` parameters to the type `Date` and the function return type as `number`.

- **Infer parameter and column nullability.** The nullable database column `email` will generate a nullable field for the query `SELECT email FROM mytable`, but will generate a non-nullable field for the query `SELECT email FROM mytable WHERE email is not null`;

- **Infer the query return type (single row vs multiple rows).** If the `id` is a primary key or unique key, then function for the query `SELECT * FROM Books where id = :id` will return `Book|null`, instead of `Book[]`. The same is true for filters with LIMIT 1;

- Allow the use of **dynamic ORDER BY** with auto-completion and compile-time verification. See [here](/docs/orderBy_limit.md).

## Usage

1. _npm install -g typesql-cli_

2. Add the `typesql.json` configuration file in project root folder. You can generate an template with cli command `typesql init`. The client option can be: 'pg', 'mysql2', 'better-sqlite3', 'libsql', 'bun:sqlite' or 'd1'. The `authToken` configuration is used only for the libsql client.

```json
{
	"databaseUri": "mysql://root:password@localhost/mydb",
	"sqlDir": "./sqls",
	"client": "mysql2",
	"authToken": "authtoken",
	"includeCrudTables": []
}
```

You can use environment variables in `typesql.json` with the `${VAR_NAME}` syntax for `databaseUri` and `authToken`.
To load variables from a `.env` file, pass the `--env-file` flag:

```sh
typesql --env-file=.env compile
```

3. Write your queries in the folder specified in the configuration file. You can also use the cli to scaffold the queries.

```
sqls\
    select-products.sql
    insert-product.sql
    update-product.sql
```

4. Then run `typesql compile --watch` to start typesql in watch mode. After that you will have one Typescript file for each query file.

```
sqls\
    select-products.sql
    select-products.ts
    insert-product.sql
    insert-product.ts
    update-product.sql
    update-product.ts
```

5. Now you can import and use the generated code.

```
const products = await selectProducts(...

const updateResult = await updateProduct(...
```

## Examples

[Query scaffolding](/docs/query_scaffolding.md)

[INSERT](/docs/insert.md)

[IN/NOT IN Clause](/docs/in_clause.md)

[MySQL FUNCTIONS](/docs/functions.md)

[ORDER BY and LIMIT clauses](/docs/orderBy_limit.md)

[LIKE](/docs/like.md)

[Nested Query Result](/docs/nested-query-result.md)

## ReScript generation from a SQL string

Generate ReScript output directly from a SQL string using the CLI. The output is printed to stdout.

- With a command-line string:

```sh
typesql rescript --name selectUsers --sql "select id, name from users"
```

- From stdin (piped):

```sh
echo "select id, name from users" | typesql rescript --name selectUsers
```

- With explicit config and env file:

```sh
typesql --config ./path/to/typesql.json --env-file .env rescript --name selectUsers --sql "select * from users"
```

Notes:

- `--name` is required and determines the logical query name used for generated types/functions.
- If `--sql` is omitted, the CLI reads SQL from stdin when piped.
- The database client and schema are resolved from your `typesql.json`.

## Daemon mode (IPC / stdio)

Run a long-lived process that reads the config and connects to the database once, then serves on-demand requests to generate ReScript. This avoids repeated startup/connection costs.

Start with a Unix socket (default `/tmp/typesql.sock`):

```sh
typesql daemon --config ./typesql.json
```

Or use stdio (NDJSON lines):

```sh
typesql daemon --stdio --config ./typesql.json
```

Request/response format (NDJSON, one JSON per line):

Request:

```json
{ "action": "rescript", "name": "selectUsers", "sql": "select id, name from users" }
```

Successful response:

```json
{ "ok": true, "action": "rescript", "name": "selectUsers", "rescript": "...", "originalTs": "..." }
```

Shutdown the daemon:

```json
{ "action": "shutdown" }
```

Using the Unix socket (`/tmp/typesql.sock`), send the same NDJSON lines to the socket and read responses line-by-line. The daemon will remain running until it receives `shutdown` or the process is terminated.

## Project Status: Under Active Development

**WARNING:** This is a work-in-progress experimental project. It is under active development and its API might change.

Issues reports and feature requests are welcome.
