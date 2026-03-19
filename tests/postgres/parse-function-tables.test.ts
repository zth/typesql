import assert from 'node:assert';
import { describeQuery } from '../../src/postgres-query-analyzer/describe';
import { PostgresSchemaDef } from '../../src/postgres-query-analyzer/types';
import { createSchemaInfo, createTestClient } from './schema';

describe('postgres-function-tables', () => {
	const client = createTestClient();
	const schemaInfo = createSchemaInfo();

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
					notNull: false,
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
					notNull: false,
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
					notNull: false,
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
