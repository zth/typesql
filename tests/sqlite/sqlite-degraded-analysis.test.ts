import assert from 'node:assert';
import { isLeft } from 'fp-ts/lib/Either';
import { validateAndGenerateCode } from '../../src/codegen/sqlite';
import { parseSql } from '../../src/sqlite-query-analyzer/parser';
import type { SQLiteDialect } from '../../src/types';
import { sqliteDbSchema } from '../mysql-query-analyzer/create-schema';
import { openTestSqliteDb } from '../fixture-paths';

describe('sqlite-degraded-analysis', () => {
	const db = openTestSqliteDb();
	const client: SQLiteDialect = {
		type: 'better-sqlite3',
		client: db
	};

	after(() => {
		db.close();
	});

	it('degrades for valid sqlite syntax that the analyzer function list does not handle', () => {
		const sql = `select printf('%s', name) as formatted from mytable2`;
		const actual = (parseSql as any)(sql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis?.mode, 'degraded');
		assert.strictEqual(value.queryType, 'Select');
		assert.strictEqual(value.multipleRowsResult, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'formatted',
				type: 'any',
				notNull: false,
				table: ''
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
		assert.ok(value.analysis?.diagnostics.length);
	});

	it('validateAndGenerateCode emits a degraded warning instead of returning an error', () => {
		const sql = `select printf('%s', name) as formatted from mytable2`;
		const actual = validateAndGenerateCode(client, sql, 'selectPrintf', sqliteDbSchema);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${actual.left.description}`);
		}

		assert.ok(actual.right.includes('degraded analysis mode'));
		assert.ok(actual.right.includes('export function selectPrintf'));
	});

	it('rejects multiple statements explicitly', () => {
		const sql = 'select 1; select 2';
		const actual = validateAndGenerateCode(client, sql, 'selectMany', sqliteDbSchema);

		if (!isLeft(actual)) {
			assert.fail('Should not accept multiple SQL statements');
		}

		assert.match(actual.left.description, /multiple sql statements are not supported/i);
	});
});
