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

	it('resolves builtin overloads from concrete argument types', () => {
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
				identity_arguments: 'bigint, bigint',
				return_type: 'SETOF bigint',
				returns_set: true,
				language: 'internal'
			},
			{
				schema: 'pg_catalog',
				function_name: 'generate_series',
				identity_arguments: 'timestamp without time zone, timestamp without time zone, interval',
				return_type: 'SETOF timestamp without time zone',
				returns_set: true,
				language: 'internal'
			}
		];

		const bigintResolution = resolvePostgresFunction({ name: 'generate_series' }, [], builtinFunctions, ['int8', 'int8']);
		assert.strictEqual(bigintResolution.status, 'resolved');
		if (bigintResolution.status !== 'resolved') {
			assert.fail('Expected resolved bigint overload');
		}
		assert.strictEqual(bigintResolution.value.returnType.kind, 'named');
		if (bigintResolution.value.returnType.kind !== 'named') {
			assert.fail('Expected named return type');
		}
		assert.strictEqual(bigintResolution.value.returnType.typeName, 'bigint');

		const timestampResolution = resolvePostgresFunction({ name: 'generate_series' }, [], builtinFunctions, ['timestamp', 'timestamp', 'interval']);
		assert.strictEqual(timestampResolution.status, 'resolved');
		if (timestampResolution.status !== 'resolved') {
			assert.fail('Expected resolved timestamp overload');
		}
		assert.strictEqual(timestampResolution.value.returnType.kind, 'named');
		if (timestampResolution.value.returnType.kind !== 'named') {
			assert.fail('Expected named return type');
		}
		assert.strictEqual(timestampResolution.value.returnType.typeName, 'timestamp without time zone');
	});

	it('resolves anyarray builtins from array argument types', () => {
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

		const actual = resolvePostgresFunction({ name: 'unnest' }, [], builtinFunctions, ['int4[]']);
		assert.strictEqual(actual.status, 'resolved');
		if (actual.status !== 'resolved') {
			assert.fail('Expected resolved function');
		}
		assert.strictEqual(actual.value.functionName, 'unnest');
	});

	it('resolves overloaded user-defined functions from argument types', () => {
		const userFunctions: UserFunctionSchema[] = [
			{
				schema: 'public',
				function_name: 'lookup_value',
				arguments: 'id integer',
				return_type: 'TABLE(id integer)',
				definition: 'select 1',
				language: 'sql'
			},
			{
				schema: 'public',
				function_name: 'lookup_value',
				arguments: 'slug text',
				return_type: 'TABLE(slug text)',
				definition: 'select 1',
				language: 'sql'
			}
		];

		const actual = resolvePostgresFunction({ schema: 'public', name: 'lookup_value' }, userFunctions, [], ['int4']);
		assert.strictEqual(actual.status, 'resolved');
		if (actual.status !== 'resolved') {
			assert.fail('Expected resolved function');
		}
		assert.strictEqual(actual.value.identityArguments, 'id integer');
	});

	it('resolves overloaded composite user-defined functions from record argument types', () => {
		const userFunctions: UserFunctionSchema[] = [
			{
				schema: 'public',
				function_name: 'lookup_entity',
				arguments: 'u users',
				return_type: 'TABLE(source text)',
				definition: 'select 1',
				language: 'sql'
			},
			{
				schema: 'public',
				function_name: 'lookup_entity',
				arguments: 'c clients',
				return_type: 'TABLE(source text)',
				definition: 'select 1',
				language: 'sql'
			}
		];

		const actual = resolvePostgresFunction({ schema: 'public', name: 'lookup_entity' }, userFunctions, [], ['public.users']);
		assert.strictEqual(actual.status, 'resolved');
		if (actual.status !== 'resolved') {
			assert.fail('Expected resolved function');
		}
		assert.strictEqual(actual.value.identityArguments, 'u users');
	});

	it('reports unresolved when no function matches', () => {
		const actual = resolvePostgresFunction({ name: 'missing_function' }, [], []);
		assert.deepStrictEqual(actual, { status: 'unresolved' });
	});
});
