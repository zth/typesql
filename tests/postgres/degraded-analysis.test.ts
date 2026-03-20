import assert from 'node:assert';
import { generateCode } from '../../src/codegen/pg';
import { describeQuery } from '../../src/postgres-query-analyzer/describe';
import { createSchemaInfo, createTestClient } from './schema';

describe('postgres-degraded-analysis', () => {
	const client = createTestClient();
	let schemaInfo: Awaited<ReturnType<typeof createSchemaInfo>>;
	const insertXmltableFallbackSql = `WITH src AS (SELECT * FROM XMLTABLE('/rows/row' PASSING '<rows><row id="1"/></rows>' COLUMNS id int PATH '@id') x) INSERT INTO mytable1(value) SELECT id FROM src RETURNING *`;
	const updateXmltableFallbackSql = `WITH src AS (SELECT * FROM XMLTABLE('/rows/row' PASSING '<rows><row id="1"/></rows>' COLUMNS id int PATH '@id') x) UPDATE mytable1 SET value = src.id FROM src WHERE mytable1.id = 1 RETURNING *`;
	const deleteXmltableFallbackSql = `WITH src AS (SELECT * FROM XMLTABLE('/rows/row' PASSING '<rows><row id="1"/></rows>' COLUMNS id int PATH '@id') x) DELETE FROM mytable1 WHERE id IN (SELECT id FROM src) RETURNING *`;
	const copyXmltableFallbackSql = `COPY (SELECT * FROM XMLTABLE('/rows/row' PASSING '<rows><row id="1"/></rows>' COLUMNS id int PATH '@id') x) TO STDOUT WITH CSV`;

	before(async () => {
		schemaInfo = await createSchemaInfo(client);
	});

	after(async () => {
		await client.end();
	});

	it('returns full analysis for SELECT * FROM generate_series(1, 5) AS g', async () => {
		const sql = 'SELECT * FROM generate_series(1, 5) AS g';
		const actual = await describeQuery(client, sql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis, undefined);
		assert.strictEqual(value.queryType, 'Select');
		assert.strictEqual(value.multipleRowsResult, true);
		assert.deepStrictEqual(value.parameters, []);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'g',
				type: 'int4',
				notNull: true,
				table: 'g'
			}
		]);
	});

	it('degrades for XMLTABLE instead of throwing', async () => {
		const sql = `SELECT *
FROM XMLTABLE('/rows/row'
	PASSING '<rows><row id="1"/></rows>'
	COLUMNS id int PATH '@id') x`;
		const actual = await describeQuery(client, sql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis?.mode, 'describe-only');
		assert.strictEqual(value.queryType, 'Select');
		assert.strictEqual(value.multipleRowsResult, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'id',
				type: 'int4',
				notNull: false,
				table: ''
			}
		]);
		assert.ok(value.analysis?.diagnostics.length);
	});

	it('returns full analysis for single-source ROWS FROM function tables', async () => {
		const sql = 'SELECT * FROM ROWS FROM (generate_series(1, 5)) AS g(value)';
		const actual = await describeQuery(client, sql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis, undefined);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'value',
				type: 'int4',
				notNull: true,
				table: 'g'
			}
		]);
	});

	it('returns full analysis for json_each without explicit column aliases', async () => {
		const sql = `SELECT * FROM json_each('{"a":1}'::json) AS t`;
		const actual = await describeQuery(client, sql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis, undefined);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'key',
				type: 'text',
				notNull: false,
				table: 't'
			},
			{
				name: 'value',
				type: 'json',
				notNull: false,
				table: 't'
			}
		]);
	});

	it('generateCode keeps json_each on the full semantic path', async () => {
		const sql = `SELECT * FROM json_each('{"a":1}'::json) AS t`;
		const actual = await generateCode({ type: 'pg', client }, sql, 'selectJsonEach', schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		assert.ok(!actual.value.includes('degraded analysis mode'));
		assert.ok(actual.value.includes('export async function selectJsonEach'));
	});

	it('generateCode emits a degraded warning for fallback analysis', async () => {
		const sql = `SELECT *
FROM XMLTABLE('/rows/row'
	PASSING '<rows><row id="1"/></rows>'
	COLUMNS id int PATH '@id') x`;
		const actual = await generateCode({ type: 'pg', client }, sql, 'selectGenerateSeries', schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		assert.ok(actual.value.includes('degraded analysis mode'));
		assert.ok(actual.value.includes('export async function selectGenerateSeries'));
	});

	it('degrades INSERT with parser-gap CTE instead of throwing', async () => {
		const actual = await describeQuery(client, insertXmltableFallbackSql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis?.mode, 'describe-only');
		assert.strictEqual(value.queryType, 'Insert');
		assert.strictEqual(value.returning, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'id',
				type: 'int4',
				notNull: false,
				table: ''
			},
			{
				name: 'value',
				type: 'int4',
				notNull: false,
				table: ''
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
		assert.ok(value.analysis?.diagnostics.length);
	});

	it('generateCode emits a degraded warning for INSERT fallback analysis', async () => {
		const actual = await generateCode({ type: 'pg', client }, insertXmltableFallbackSql, 'insertXmltableFallback', schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		assert.ok(actual.value.includes('degraded analysis mode'));
		assert.ok(actual.value.includes('export async function insertXmltableFallback'));
	});

	it('degrades UPDATE with parser-gap CTE instead of throwing', async () => {
		const actual = await describeQuery(client, updateXmltableFallbackSql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis?.mode, 'describe-only');
		assert.strictEqual(value.queryType, 'Update');
		assert.strictEqual(value.returning, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'id',
				type: 'int4',
				notNull: false,
				table: ''
			},
			{
				name: 'value',
				type: 'int4',
				notNull: false,
				table: ''
			},
			{
				name: 'id',
				type: 'int4',
				notNull: false,
				table: ''
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
		assert.ok(value.analysis?.diagnostics.length);
	});

	it('generateCode emits a degraded warning for UPDATE fallback analysis', async () => {
		const actual = await generateCode({ type: 'pg', client }, updateXmltableFallbackSql, 'updateXmltableFallback', schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		assert.ok(actual.value.includes('degraded analysis mode'));
		assert.ok(actual.value.includes('export async function updateXmltableFallback'));
	});

	it('degrades DELETE with parser-gap CTE instead of throwing', async () => {
		const actual = await describeQuery(client, deleteXmltableFallbackSql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis?.mode, 'describe-only');
		assert.strictEqual(value.queryType, 'Delete');
		assert.strictEqual(value.returning, true);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'id',
				type: 'int4',
				notNull: false,
				table: ''
			},
			{
				name: 'value',
				type: 'int4',
				notNull: false,
				table: ''
			}
		]);
		assert.deepStrictEqual(value.parameters, []);
		assert.ok(value.analysis?.diagnostics.length);
	});

	it('generateCode emits a degraded warning for DELETE fallback analysis', async () => {
		const actual = await generateCode({ type: 'pg', client }, deleteXmltableFallbackSql, 'deleteXmltableFallback', schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		assert.ok(actual.value.includes('degraded analysis mode'));
		assert.ok(actual.value.includes('export async function deleteXmltableFallback'));
	});

	it('degrades COPY parser-gap queries instead of throwing', async () => {
		const actual = await describeQuery(client, copyXmltableFallbackSql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis?.mode, 'describe-only');
		assert.strictEqual(value.queryType, 'Copy');
		assert.deepStrictEqual(value.columns, []);
		assert.deepStrictEqual(value.parameters, []);
		assert.ok(value.analysis?.diagnostics.length);
	});

	it('generateCode emits a degraded warning for COPY fallback analysis', async () => {
		const actual = await generateCode({ type: 'pg', client }, copyXmltableFallbackSql, 'copyXmltableFallback', schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		assert.ok(actual.value.includes('degraded analysis mode'));
		assert.ok(actual.value.includes('export async function copyXmltableFallback'));
	});

	it('keeps recursive CTE analysis on the full semantic path', async () => {
		const sql = `
			WITH RECURSIVE cte as (
				SELECT     t1.id, 0 as level
				FROM       mytable1 t1
				WHERE      id is null
				UNION ALL
				SELECT     t1.id,
							level+1 as level
				FROM       cte c
				INNER JOIN mytable1 t1
						on c.id = t1.id
			)
			SELECT * from cte
			`;
		const actual = await describeQuery(client, sql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis, undefined);
		assert.deepStrictEqual(value.columns, [
			{
				name: 'id',
				type: 'int4',
				notNull: true,
				table: 'cte'
			},
			{
				name: 'level',
				type: 'int4',
				notNull: true,
				table: 'cte'
			}
		]);
	});

	it('generateCode keeps recursive CTE analysis off the degraded fallback path', async () => {
		const sql = `
			WITH RECURSIVE cte as (
				SELECT     t1.id, 0 as level
				FROM       mytable1 t1
				WHERE      id is null
				UNION ALL
				SELECT     t1.id,
							level+1 as level
				FROM       cte c
				INNER JOIN mytable1 t1
						on c.id = t1.id
			)
			SELECT * from cte
			`;
		const actual = await generateCode({ type: 'pg', client }, sql, 'selectRecursiveCte', schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		assert.ok(!actual.value.includes('degraded analysis mode'));
		assert.ok(actual.value.includes('export async function selectRecursiveCte'));
	});

	it('rejects multiple statements explicitly', async () => {
		const sql = 'SELECT 1; SELECT 2';
		const actual = await describeQuery(client, sql, schemaInfo);

		if (actual.isOk()) {
			assert.fail('Should not accept multiple SQL statements');
		}

		assert.match(actual.error.description, /multiple sql statements are not supported/i);
	});
});
