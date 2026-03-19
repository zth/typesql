import assert from 'node:assert';
import { parseSql } from '../../src/postgres-query-analyzer/parser';
import { builtinFunctions, checkConstraints, schema } from './schema';
import { UserFunctionSchema } from '../../src/postgres-query-analyzer/types';

const overloadedUserFunctions: UserFunctionSchema[] = [
	{
		schema: 'public',
		function_name: 'lookup_entity',
		arguments: 'u users',
		return_type: 'TABLE(source text)',
		definition: `SELECT 'user' AS source`,
		language: 'sql'
	},
	{
		schema: 'public',
		function_name: 'lookup_entity',
		arguments: 'c clients',
		return_type: 'TABLE(source text)',
		definition: `SELECT 'client' AS source`,
		language: 'sql'
	}
];

describe('postgres-overloaded-function-tables', () => {
	it('resolves composite user-function overloads from a users row argument', () => {
		const sql = `SELECT e.* FROM users u CROSS JOIN LATERAL lookup_entity(u) e`;
		const actual = parseSql(sql, schema, checkConstraints, overloadedUserFunctions, builtinFunctions);

		assert.deepStrictEqual(actual.columns, [
			{
				column_name: 'source',
				is_nullable: false,
				original_is_nullable: false,
				table: 'e',
				schema: '',
				type: 'text'
			}
		]);
		assert.strictEqual(actual.multipleRowsResult, true);
		assert.deepStrictEqual(actual.parametersNullability, []);
	});

	it('resolves composite user-function overloads from a clients row argument', () => {
		const sql = `SELECT e.* FROM clients c CROSS JOIN LATERAL lookup_entity(c) e`;
		const actual = parseSql(sql, schema, checkConstraints, overloadedUserFunctions, builtinFunctions);

		assert.deepStrictEqual(actual.columns, [
			{
				column_name: 'source',
				is_nullable: false,
				original_is_nullable: false,
				table: 'e',
				schema: '',
				type: 'text'
			}
		]);
		assert.strictEqual(actual.multipleRowsResult, true);
		assert.deepStrictEqual(actual.parametersNullability, []);
	});
});
