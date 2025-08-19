import assert from 'node:assert';
import { generateReScriptFromSql } from '../../src/rescript';
import { createSqliteClient, loadDbSchema } from '../../src/sqlite-query-analyzer/query-executor';
import type { SchemaInfo } from '../../src/schema-info';
import fs from 'node:fs';

const WRITE_FILES = false;

describe('api: generateReScriptFromSql (SQLite)', () => {
	it('generates code for a simple select', async () => {
		const clientResult = createSqliteClient('better-sqlite3', ':memory:', [], []);
		if ((clientResult as any).isErr && (clientResult as any).isErr()) {
			assert.fail('Failed to create SQLite client');
		}
		const databaseClient = (clientResult as any).value;

		// Create a simple table
		databaseClient.client.exec(`
		create table users (
			id integer primary key,
			name text not null,
			created_at text,
			age int,
			score float,
			balance numeric,
			is_active bool,
			blob_col blob,
			date_col date,
			date_time_col datetime,
			enum_col text check (enum_col in ('x-small','small','medium','large','x-large'))
		);
		`);

		const schemaRes = loadDbSchema(databaseClient.client);
		if (schemaRes.isErr()) {
			assert.fail('Failed to load SQLite schema');
		}

		const schemaInfo: SchemaInfo = {
			kind: 'better-sqlite3',
			columns: schemaRes.value
		};

		const sql = `select *, true as bool_expr, date('now') as date_expr, datetime('now') as datetime_expr from users where id in (case when :ids is not null then :ids else null end) and name in (:names) and score in (:scores) and balance in (:balances)`;

		const queryName = 'selectUsers';
		const { rescript, originalTs } = await generateReScriptFromSql({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('sqlite-generate-rescript.select-users.rescript.txt', rescript);
			fs.writeFileSync('sqlite-generate-rescript.select-users.ts.txt', originalTs);
		}

		assert.deepEqual(rescript, fs.readFileSync('sqlite-generate-rescript.select-users.rescript.txt', 'utf8'));
	});

	it('generates code for a nested select (@nested)', async () => {
		const clientResult = createSqliteClient('better-sqlite3', ':memory:', [], []);
		if ((clientResult as any).isErr && (clientResult as any).isErr()) {
			assert.fail('Failed to create SQLite client');
		}
		const databaseClient = (clientResult as any).value;

		// Create tables similar to the docs example
		databaseClient.client.exec(`
		create table users (
			id integer primary key,
			name text not null
		);
		create table posts (
			id integer primary key,
			title text not null,
			body text not null,
			fk_user integer
		);
		`);

		const schemaRes = loadDbSchema(databaseClient.client);
		if (schemaRes.isErr()) {
			assert.fail('Failed to load SQLite schema');
		}

		const schemaInfo: SchemaInfo = {
			kind: 'better-sqlite3',
			columns: schemaRes.value
		};

		// Example mirrors docs/nested-query-result.md
		const sql = `-- @nested
		SELECT
			users.id,
			users.name,
			posts.id,
			posts.title,
			posts.body
		FROM users
		INNER JOIN posts on posts.fk_user = users.id`;

		const queryName = 'selectUserPosts';
		const { rescript, originalTs } = await generateReScriptFromSql({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('sqlite-generate-rescript.select-user-posts-nested.rescript.txt', rescript);
			fs.writeFileSync('sqlite-generate-rescript.select-user-posts-nested.ts.txt', originalTs);
		}

		assert.deepEqual(rescript, fs.readFileSync('sqlite-generate-rescript.select-user-posts-nested.rescript.txt', 'utf8'));
	});

	it('generates code for a dynamic query (@dynamicQuery)', async () => {
		const clientResult = createSqliteClient('better-sqlite3', ':memory:', [], []);
		if ((clientResult as any).isErr && (clientResult as any).isErr()) {
			assert.fail('Failed to create SQLite client');
		}
		const databaseClient = (clientResult as any).value;

		// Create minimal tables for the dynamic query
		databaseClient.client.exec(`
		create table mytable1 (
			id integer primary key,
			value integer
		);
		create table mytable2 (
			id integer primary key,
			name text not null,
			descr text
		);
		`);

		const schemaRes = loadDbSchema(databaseClient.client);
		if (schemaRes.isErr()) {
			assert.fail('Failed to load SQLite schema');
		}

		const schemaInfo: SchemaInfo = {
			kind: 'better-sqlite3',
			columns: schemaRes.value
		};

		const sql = `-- @dynamicQuery
SELECT m1.id, m1.value, m2.name, m2.descr as description
FROM mytable1 m1
INNER JOIN mytable2 m2 on m1.id = m2.id
WHERE m2.name = :name
AND m2.descr = :description`;

		const queryName = 'dynamicQuery01';
		const { rescript, originalTs } = await generateReScriptFromSql({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('sqlite-generate-rescript.dynamic-query01.rescript.txt', rescript);
			fs.writeFileSync('sqlite-generate-rescript.dynamic-query01.ts.txt', originalTs);
		}

		assert.deepEqual(rescript, fs.readFileSync('sqlite-generate-rescript.dynamic-query01.rescript.txt', 'utf8'));
	});
});
