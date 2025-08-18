import assert from 'node:assert';
import { generateReScriptFromSql } from '../../src/rescript';
import { createSqliteClient, loadDbSchema } from '../../src/sqlite-query-analyzer/query-executor';
import type { SchemaInfo } from '../../src/schema-info';
import fs from 'node:fs';

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
		const { rescript, originalTs: _ } = await generateReScriptFromSql({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		// fs.writeFileSync('sqlite-generate-rescript.select-users.rescript.txt', rescript);
		// fs.writeFileSync('sqlite-generate-rescript.select-users.ts.txt', originalTs);

		assert.deepEqual(rescript, fs.readFileSync('sqlite-generate-rescript.select-users.rescript.txt', 'utf8'));
	});
});
