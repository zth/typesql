import assert from 'node:assert';
import postgres from 'postgres';
import { loadBuiltinFunctions } from '../../src/drivers/postgres';
import { loadSchemaInfo } from '../../src/schema-info';
import { PgDielect, TypeSqlError } from '../../src/types';
import { createTestClient } from './schema';

describe('postgres-builtin-functions', () => {
	const sql = createTestClient();

	after(async () => {
		await sql.end();
	});

	it('loadBuiltinFunctions-connection-error', async () => {
		const client = postgres('postgres://postgres:password123@127.0.0.1:5432/postgres');
		const result = await loadBuiltinFunctions(client);
		if (result.isOk()) {
			assert.fail('Should return an error');
		}

		const expected: TypeSqlError = {
			name: 'PostgresError',
			description: `password authentication failed for user "postgres"`
		};
		assert.deepStrictEqual(result.error, expected);
	});

	it('loadBuiltinFunctions', async () => {
		const result = await loadBuiltinFunctions(sql);

		if (result.isErr()) {
			assert.fail(`Shouldn't return an error: ${result.error.description}`);
		}

		assert.ok(result.value.length > 0);
		assert.ok(result.value.every((fn) => fn.schema === 'pg_catalog'));
		assert.ok(result.value.every((fn) => fn.returns_set === true));
		assert.ok(result.value.every((fn) => fn.language.length > 0));
		assert.ok(result.value.some((fn) => fn.function_name === 'generate_series' && fn.return_type.length > 0));
		assert.ok(result.value.some((fn) => fn.function_name === 'unnest' && fn.identity_arguments.length > 0));
		assert.ok(result.value.some((fn) => fn.function_name === 'jsonb_to_recordset'));
		assert.ok(result.value.some((fn) => fn.function_name === 'regexp_split_to_table'));
		assert.ok(!result.value.some((fn) => fn.function_name === 'get_mytable1'));
	});

	it('loadSchemaInfo includes builtinFunctions alongside userFunctions', async () => {
		const client: PgDielect = {
			type: 'pg',
			client: sql
		};
		const result = await loadSchemaInfo(client, ['public']);

		if (result.isErr()) {
			assert.fail(`Shouldn't return an error: ${result.error.description}`);
		}
		if (result.value.kind !== 'pg') {
			assert.fail('Expected postgres schema info');
		}

		assert.ok(result.value.builtinFunctions.length > 0);
		assert.ok(result.value.builtinFunctions.some((fn) => fn.function_name === 'generate_series'));
		assert.ok(result.value.builtinFunctions.some((fn) => fn.function_name === 'unnest'));
		assert.ok(result.value.userFunctions.some((fn) => fn.function_name === 'get_mytable1'));
	});
});
