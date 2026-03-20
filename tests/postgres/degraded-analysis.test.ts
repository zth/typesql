import assert from 'node:assert';
import { generateCode } from '../../src/codegen/pg';
import { describeQuery } from '../../src/postgres-query-analyzer/describe';
import { createSchemaInfo, createTestClient } from './schema';

describe('postgres-degraded-analysis', () => {
	const client = createTestClient();
	let schemaInfo: Awaited<ReturnType<typeof createSchemaInfo>>;

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

	it('keeps recursive CTE analysis in degraded mode instead of describe-only', async () => {
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
		assert.strictEqual(value.analysis?.mode, 'degraded');
		assert.deepStrictEqual(value.analysis?.diagnostics, [
			{
				code: 'postgres.unresolved_column',
				message: 'Column not found: level'
			}
		]);
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
				notNull: false,
				table: 'cte'
			}
		]);
	});

	it('generateCode emits a degraded warning for traversal fallback analysis', async () => {
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

		assert.ok(actual.value.includes('degraded analysis mode'));
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
