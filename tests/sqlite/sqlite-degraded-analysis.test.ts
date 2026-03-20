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
	const castSql = `select cast(:value as text) as casted from mytable1`;
	const postfixNullSql = `select value isnull as is_null, value notnull as is_not_null from mytable1`;
	const regexpSql = `select name regexp '^a' as matches from mytable2`;
	const likeEscapeSql = `select name like :pattern escape :escape as matches from mytable2`;
	const insertCollateFallbackSql = `INSERT INTO mytable1(value) VALUES ((1 COLLATE nocase)) RETURNING *`;
	const updateCollateFallbackSql = `UPDATE mytable1 SET value = (1 COLLATE nocase) WHERE id = 1 RETURNING *`;
	const deleteCollateFallbackSql = `DELETE FROM mytable1 WHERE (id COLLATE nocase) = 1 RETURNING *`;

	after(() => {
		db.close();
	});

	it('keeps valid sqlite unknown functions on the semantic path', () => {
		const sql = `select printf('%s', name) as formatted from mytable2`;
		const actual = (parseSql as any)(sql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis, undefined);
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
	});

	it('validateAndGenerateCode keeps valid sqlite unknown functions off the degraded path', () => {
		const sql = `select printf('%s', name) as formatted from mytable2`;
		const actual = validateAndGenerateCode(client, sql, 'selectPrintf', sqliteDbSchema);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${actual.left.description}`);
		}

		assert.ok(!actual.right.includes('degraded analysis mode'));
		assert.ok(actual.right.includes('export function selectPrintf'));
	});

	it('keeps sqlite CAST expressions on the semantic path', () => {
		const actual = (parseSql as any)(castSql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis, undefined);
		assert.strictEqual(value.queryType, 'Select');
		assert.strictEqual(value.multipleRowsResult, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'casted',
				type: 'TEXT',
				notNull: true,
				table: ''
			}
		]);
		assert.deepStrictEqual(value.parameters, [
			{
				name: 'value',
				columnType: 'TEXT',
				notNull: true
			}
		]);
	});

	it('validateAndGenerateCode keeps sqlite CAST expressions off the degraded path', () => {
		const actual = validateAndGenerateCode(client, castSql, 'selectCast', sqliteDbSchema);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${actual.left.description}`);
		}

		assert.ok(!actual.right.includes('degraded analysis mode'));
		assert.ok(actual.right.includes('export function selectCast'));
	});

	it('keeps sqlite postfix null checks on the semantic path', () => {
		const actual = (parseSql as any)(postfixNullSql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis, undefined);
		assert.strictEqual(value.queryType, 'Select');
		assert.strictEqual(value.multipleRowsResult, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'is_null',
				type: 'INTEGER',
				notNull: true,
				table: ''
			},
			{
				name: 'is_not_null',
				type: 'INTEGER',
				notNull: true,
				table: ''
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
	});

	it('validateAndGenerateCode keeps sqlite postfix null checks off the degraded path', () => {
		const actual = validateAndGenerateCode(client, postfixNullSql, 'selectPostfixNull', sqliteDbSchema);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${actual.left.description}`);
		}

		assert.ok(!actual.right.includes('degraded analysis mode'));
		assert.ok(actual.right.includes('export function selectPostfixNull'));
	});

	it('keeps sqlite REGEXP expressions on the semantic path', () => {
		const actual = (parseSql as any)(regexpSql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis, undefined);
		assert.strictEqual(value.queryType, 'Select');
		assert.strictEqual(value.multipleRowsResult, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'matches',
				type: 'INTEGER',
				notNull: true,
				table: ''
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
	});

	it('keeps sqlite LIKE ESCAPE parameters on the semantic path', () => {
		const actual = (parseSql as any)(likeEscapeSql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis, undefined);
		assert.strictEqual(value.queryType, 'Select');
		assert.strictEqual(value.multipleRowsResult, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'matches',
				type: 'INTEGER',
				notNull: true,
				table: ''
			}
		]);
		assert.deepStrictEqual(value.parameters, [
			{
				name: 'pattern',
				columnType: 'TEXT',
				notNull: true
			},
			{
				name: 'escape',
				columnType: 'TEXT',
				notNull: true
			}
		]);
	});

	it('validateAndGenerateCode keeps sqlite LIKE ESCAPE parameters off the degraded path', () => {
		const actual = validateAndGenerateCode(client, likeEscapeSql, 'selectLikeEscape', sqliteDbSchema);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${actual.left.description}`);
		}

		assert.ok(!actual.right.includes('degraded analysis mode'));
		assert.ok(actual.right.includes('export function selectLikeEscape'));
	});

	it('keeps INSERT DML COLLATE expressions on the semantic path', () => {
		const actual = (parseSql as any)(insertCollateFallbackSql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis, undefined);
		assert.strictEqual(value.queryType, 'Insert');
		assert.strictEqual(value.returning, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'id',
				type: 'INTEGER',
				notNull: true
			},
			{
				name: 'value',
				type: 'INTEGER',
				notNull: false
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
	});

	it('validateAndGenerateCode keeps INSERT DML COLLATE expressions off the degraded path', () => {
		const actual = validateAndGenerateCode(client, insertCollateFallbackSql, 'insertCollateFallback', sqliteDbSchema);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${actual.left.description}`);
		}

		assert.ok(!actual.right.includes('degraded analysis mode'));
		assert.ok(actual.right.includes('export function insertCollateFallback'));
	});

	it('keeps UPDATE DML COLLATE expressions on the semantic path', () => {
		const actual = (parseSql as any)(updateCollateFallbackSql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis, undefined);
		assert.strictEqual(value.queryType, 'Update');
		assert.strictEqual(value.returning, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'id',
				type: 'INTEGER',
				notNull: true
			},
			{
				name: 'value',
				type: 'INTEGER',
				notNull: false
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
	});

	it('validateAndGenerateCode keeps UPDATE DML COLLATE expressions off the degraded path', () => {
		const actual = validateAndGenerateCode(client, updateCollateFallbackSql, 'updateCollateFallback', sqliteDbSchema);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${actual.left.description}`);
		}

		assert.ok(!actual.right.includes('degraded analysis mode'));
		assert.ok(actual.right.includes('export function updateCollateFallback'));
	});

	it('keeps DELETE DML COLLATE expressions on the semantic path', () => {
		const actual = (parseSql as any)(deleteCollateFallbackSql, sqliteDbSchema, db);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${(actual.left as any).description}`);
		}

		const value = actual.right as any;
		assert.strictEqual(value.analysis, undefined);
		assert.strictEqual(value.queryType, 'Delete');
		assert.strictEqual(value.returning, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'id',
				type: 'INTEGER',
				notNull: true
			},
			{
				name: 'value',
				type: 'INTEGER',
				notNull: false
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
	});

	it('validateAndGenerateCode keeps DELETE DML COLLATE expressions off the degraded path', () => {
		const actual = validateAndGenerateCode(client, deleteCollateFallbackSql, 'deleteCollateFallback', sqliteDbSchema);

		if (isLeft(actual)) {
			assert.fail(`Should not fail outright: ${actual.left.description}`);
		}

		assert.ok(!actual.right.includes('degraded analysis mode'));
		assert.ok(actual.right.includes('export function deleteCollateFallback'));
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
