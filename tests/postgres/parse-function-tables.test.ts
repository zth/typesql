import assert from 'node:assert';
import { describeQuery } from '../../src/postgres-query-analyzer/describe';
import { PostgresSchemaDef } from '../../src/postgres-query-analyzer/types';
import { createSchemaInfo, createTestClient } from './schema';

describe('postgres-function-tables', () => {
	const client = createTestClient();
	let schemaInfo: Awaited<ReturnType<typeof createSchemaInfo>>;

	before(async () => {
		schemaInfo = await createSchemaInfo(client);
	});

	after(async () => {
		await client.end();
	});

	it('SELECT * FROM generate_series(1, 5) AS g(value)', async () => {
		const sql = 'SELECT * FROM generate_series(1, 5) AS g(value)';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'value',
					type: 'int4',
					notNull: true,
					table: 'g'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM generate_series(1, 5) AS g WHERE g > 2', async () => {
		const sql = 'SELECT * FROM generate_series(1, 5) AS g WHERE g > 2';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'g',
					type: 'int4',
					notNull: true,
					table: 'g'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM generate_series(1::bigint, 5::bigint) AS g(value)', async () => {
		const sql = 'SELECT * FROM generate_series(1::bigint, 5::bigint) AS g(value)';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'value',
					type: 'int8',
					notNull: true,
					table: 'g'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM generate_series(1, 5) WITH ORDINALITY AS g(value, ord)', async () => {
		const sql = 'SELECT * FROM generate_series(1, 5) WITH ORDINALITY AS g(value, ord)';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'value',
					type: 'int4',
					notNull: true,
					table: 'g'
				},
				{
					name: 'ord',
					type: 'int8',
					notNull: true,
					table: 'g'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM generate_series(1, 5) WITH ORDINALITY', async () => {
		const sql = 'SELECT * FROM generate_series(1, 5) WITH ORDINALITY';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'generate_series',
					type: 'int4',
					notNull: true,
					table: 'generate_series'
				},
				{
					name: 'ordinality',
					type: 'int8',
					notNull: true,
					table: 'generate_series'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM ROWS FROM (generate_series(1,3), generate_series(10,12)) AS t(a,b)', async () => {
		const sql = 'SELECT * FROM ROWS FROM (generate_series(1,3), generate_series(10,12)) AS t(a,b)';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'a',
					type: 'int4',
					notNull: false,
					table: 't'
				},
				{
					name: 'b',
					type: 'int4',
					notNull: false,
					table: 't'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM ROWS FROM (generate_series(1,3), generate_series(10,12)) WITH ORDINALITY AS t(a,b,ord)', async () => {
		const sql = 'SELECT * FROM ROWS FROM (generate_series(1,3), generate_series(10,12)) WITH ORDINALITY AS t(a,b,ord)';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'a',
					type: 'int4',
					notNull: false,
					table: 't'
				},
				{
					name: 'b',
					type: 'int4',
					notNull: false,
					table: 't'
				},
				{
					name: 'ord',
					type: 'int8',
					notNull: true,
					table: 't'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM generate_series(timestamp, timestamp, interval) AS g(value)', async () => {
		const sql = `SELECT * FROM generate_series('2024-01-01'::timestamp, '2024-01-03'::timestamp, '1 day'::interval) AS g(value)`;
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'value',
					type: 'timestamp',
					notNull: true,
					table: 'g'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM generate_subscripts(ARRAY[10,20], 1) AS g(subscript)', async () => {
		const sql = 'SELECT * FROM generate_subscripts(ARRAY[10, 20], 1) AS g(subscript)';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'subscript',
					type: 'int4',
					notNull: true,
					table: 'g'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM jsonb_object_keys(...) AS g(key)', async () => {
		const sql = `SELECT * FROM jsonb_object_keys('{"a":1,"b":2}'::jsonb) AS g(key)`;
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'key',
					type: 'text',
					notNull: true,
					table: 'g'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM unnest(ARRAY[1,2,3]) AS t(id)', async () => {
		const sql = 'SELECT * FROM unnest(ARRAY[1, 2, 3]) AS t(id)';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'id',
					type: 'int4',
					notNull: false,
					table: 't'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM unnest(ARRAY[1,2,3]) WITH ORDINALITY AS t(id, ord)', async () => {
		const sql = 'SELECT * FROM unnest(ARRAY[1, 2, 3]) WITH ORDINALITY AS t(id, ord)';
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'id',
					type: 'int4',
					notNull: false,
					table: 't'
				},
				{
					name: 'ord',
					type: 'int8',
					notNull: true,
					table: 't'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM jsonb_to_recordset(...) AS t(id int, name text)', async () => {
		const sql = `SELECT * FROM jsonb_to_recordset('[{"id":1,"name":"a"}]') AS t(id int, name text)`;
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'id',
					type: 'int4',
					notNull: false,
					table: 't'
				},
				{
					name: 'name',
					type: 'text',
					notNull: false,
					table: 't'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM ROWS FROM (jsonb_to_recordset(...) AS (id int, name text), generate_series(1,3)) AS t(id,name,g)', async () => {
		const sql = `SELECT * FROM ROWS FROM (jsonb_to_recordset('[{"id":1,"name":"a"}]') AS (id int, name text), generate_series(1,3)) AS t(id, name, g)`;
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'id',
					type: 'int4',
					notNull: false,
					table: 't'
				},
				{
					name: 'name',
					type: 'text',
					notNull: false,
					table: 't'
				},
				{
					name: 'g',
					type: 'int4',
					notNull: false,
					table: 't'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});

	it('SELECT * FROM jsonb_to_recordset(...) AS t(id int, name text) WHERE id > 0', async () => {
		const sql = `SELECT * FROM jsonb_to_recordset('[{"id":1,"name":"a"}]') AS t(id int, name text) WHERE id > 0`;
		const actual = await describeQuery(client, sql, schemaInfo);
		const expected: PostgresSchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: true,
			columns: [
				{
					name: 'id',
					type: 'int4',
					notNull: true,
					table: 't'
				},
				{
					name: 'name',
					type: 'text',
					notNull: false,
					table: 't'
				}
			],
			parameters: []
		};

		if (actual.isErr()) {
			assert.fail(`Shouldn't return an error: ${actual.error.description}`);
		}

		assert.deepStrictEqual(actual.value, expected);
	});
});
