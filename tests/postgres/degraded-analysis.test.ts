import assert from 'node:assert';
import { generateCode } from '../../src/codegen/pg';
import { describeQuery } from '../../src/postgres-query-analyzer/describe';
import { createSchemaInfo, createTestClient } from './schema';

describe('postgres-degraded-analysis', () => {
	const client = createTestClient();
	const schemaInfo = createSchemaInfo();

	after(async () => {
		await client.end();
	});

	it('degrades for SELECT * FROM generate_series(1, 5) AS g', async () => {
		const sql = 'SELECT * FROM generate_series(1, 5) AS g';
		const actual = await describeQuery(client, sql, schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		const value = actual.value as any;
		assert.strictEqual(value.analysis?.mode, 'describe-only');
		assert.strictEqual(value.queryType, 'Select');
		assert.strictEqual(value.multipleRowsResult, true);
		assert.deepStrictEqual(value.parameters, []);
		assert.strictEqual(value.columns.length, 1);
		assert.strictEqual(value.columns[0].type, 'int4');
		assert.strictEqual(value.columns[0].notNull, false);
		assert.ok(value.analysis?.diagnostics.length);
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

	it('generateCode emits a degraded warning for fallback analysis', async () => {
		const sql = 'SELECT * FROM generate_series(1, 5) AS g';
		const actual = await generateCode({ type: 'pg', client }, sql, 'selectGenerateSeries', schemaInfo);

		if (actual.isErr()) {
			assert.fail(`Should not fail outright: ${actual.error.description}`);
		}

		assert.ok(actual.value.includes('degraded analysis mode'));
		assert.ok(actual.value.includes('export async function selectGenerateSeries'));
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
