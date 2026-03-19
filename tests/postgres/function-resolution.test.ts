import assert from 'node:assert';
import { PostgresBuiltinFunctionSchema } from '../../src/postgres-query-analyzer/builtin-functions';
import { normalizeBuiltinFunction, normalizeUserFunction, parseFunctionReturnType, resolvePostgresFunction } from '../../src/postgres-query-analyzer/function-resolution';
import { UserFunctionSchema } from '../../src/postgres-query-analyzer/types';

describe('postgres-function-resolution', () => {
	it('parses TABLE return types with nested commas in type arguments', () => {
		const actual = parseFunctionReturnType('TABLE(total numeric(10,5), label text, created_at timestamp without time zone)', true);

		assert.deepStrictEqual(actual, {
			kind: 'table',
			returnsSet: true,
			columns: [
				{ name: 'total', type: 'numeric(10,5)' },
				{ name: 'label', type: 'text' },
				{ name: 'created_at', type: 'timestamp without time zone' }
			]
		});
	});

	it('parses SETOF named return types', () => {
		const actual = parseFunctionReturnType('SETOF integer', true);

		assert.deepStrictEqual(actual, {
			kind: 'named',
			typeName: 'integer',
			returnsSet: true
		});
	});

	it('parses record return types', () => {
		assert.deepStrictEqual(parseFunctionReturnType('SETOF record', true), {
			kind: 'record',
			returnsSet: true
		});
		assert.deepStrictEqual(parseFunctionReturnType('record', false), {
			kind: 'record',
			returnsSet: false
		});
	});

	it('normalizes user-defined functions', () => {
		const userFunction: UserFunctionSchema = {
			schema: 'public',
			function_name: 'get_users',
			arguments: 'user_id integer',
			return_type: 'TABLE(id integer, name text)',
			definition: 'select 1',
			language: 'sql'
		};

		const actual = normalizeUserFunction(userFunction);
		assert.strictEqual(actual.origin, 'user');
		assert.strictEqual(actual.functionName, 'get_users');
		assert.strictEqual(actual.identityArguments, 'user_id integer');
		assert.strictEqual(actual.returnType.kind, 'table');
	});

	it('normalizes builtin functions', () => {
		const builtinFunction: PostgresBuiltinFunctionSchema = {
			schema: 'pg_catalog',
			function_name: 'generate_series',
			identity_arguments: 'integer, integer',
			return_type: 'SETOF integer',
			returns_set: true,
			language: 'internal'
		};

		const actual = normalizeBuiltinFunction(builtinFunction);
		assert.strictEqual(actual.origin, 'builtin');
		assert.strictEqual(actual.functionName, 'generate_series');
		assert.deepStrictEqual(actual.returnType, {
			kind: 'named',
			typeName: 'integer',
			returnsSet: true
		});
	});

	it('resolves unqualified user functions before builtins', () => {
		const userFunctions: UserFunctionSchema[] = [
			{
				schema: 'public',
				function_name: 'generate_series',
				arguments: '',
				return_type: 'TABLE(id integer)',
				definition: 'select 1',
				language: 'sql'
			}
		];
		const builtinFunctions: PostgresBuiltinFunctionSchema[] = [
			{
				schema: 'pg_catalog',
				function_name: 'generate_series',
				identity_arguments: 'integer, integer',
				return_type: 'SETOF integer',
				returns_set: true,
				language: 'internal'
			}
		];

		const actual = resolvePostgresFunction({ name: 'generate_series' }, userFunctions, builtinFunctions);
		assert.strictEqual(actual.status, 'resolved');
		if (actual.status !== 'resolved') {
			assert.fail('Expected resolved function');
		}
		assert.strictEqual(actual.value.origin, 'user');
		assert.strictEqual(actual.value.schema, 'public');
	});

	it('resolves schema-qualified builtin functions', () => {
		const builtinFunctions: PostgresBuiltinFunctionSchema[] = [
			{
				schema: 'pg_catalog',
				function_name: 'unnest',
				identity_arguments: 'anyarray',
				return_type: 'SETOF anyelement',
				returns_set: true,
				language: 'internal'
			}
		];

		const actual = resolvePostgresFunction({ schema: 'pg_catalog', name: 'unnest' }, [], builtinFunctions);
		assert.strictEqual(actual.status, 'resolved');
		if (actual.status !== 'resolved') {
			assert.fail('Expected resolved function');
		}
		assert.strictEqual(actual.value.origin, 'builtin');
		assert.strictEqual(actual.value.functionName, 'unnest');
	});

	it('reports ambiguous overloads when resolution is name-only', () => {
		const builtinFunctions: PostgresBuiltinFunctionSchema[] = [
			{
				schema: 'pg_catalog',
				function_name: 'generate_series',
				identity_arguments: 'integer, integer',
				return_type: 'SETOF integer',
				returns_set: true,
				language: 'internal'
			},
			{
				schema: 'pg_catalog',
				function_name: 'generate_series',
				identity_arguments: 'timestamp, timestamp, interval',
				return_type: 'SETOF timestamp without time zone',
				returns_set: true,
				language: 'internal'
			}
		];

		const actual = resolvePostgresFunction({ name: 'generate_series' }, [], builtinFunctions);
		assert.strictEqual(actual.status, 'ambiguous');
		if (actual.status !== 'ambiguous') {
			assert.fail('Expected ambiguous function resolution');
		}
		assert.strictEqual(actual.candidates.length, 2);
	});

	it('reports unresolved when no function matches', () => {
		const actual = resolvePostgresFunction({ name: 'missing_function' }, [], []);
		assert.deepStrictEqual(actual, { status: 'unresolved' });
	});
});
