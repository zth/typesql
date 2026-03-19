import tsBlankSpace from 'ts-blank-space';
import { recordOrEmpty } from '../cli-io';
import { convertToCamelCaseName } from '../codegen/shared/codegen-util';
import type { DatabaseClient } from '../types';
import type { RescriptQueryDescriptor, ResolvedQuery } from './query-resolver';

type CapturedQuery = {
	sql: string;
	bindValues: unknown[];
};

class CapturedQueryError extends Error {
	capture: CapturedQuery;

	constructor(capture: CapturedQuery) {
		super('Captured generated query');
		this.capture = capture;
	}
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;

export async function resolveQueryWithGeneratedCode(params: {
	queryName: string;
	originalTs: string;
	dialect: DatabaseClient['type'];
	descriptor: RescriptQueryDescriptor;
	variables?: unknown;
	baseResolved: ResolvedQuery;
}): Promise<ResolvedQuery> {
	if (!params.baseResolved.resolved || params.baseResolved.executableSql != null) {
		return params.baseResolved;
	}
	if (params.descriptor.queryType === 'Copy') {
		throw new Error('Copy queries are not supported by the ReScript inspect/explain/exec tooling yet.');
	}

	const queryModule = await loadGeneratedQueryModule(params.originalTs);
	const functionName = convertToCamelCaseName(params.queryName);
	const queryFn = queryModule[functionName];
	if (typeof queryFn !== 'function') {
		throw new Error(`Could not find generated query function '${functionName}'.`);
	}

	const fakeClient = createCaptureClient(params.dialect);
	try {
		const result = queryFn(...buildInvocationArgs(fakeClient, params.descriptor, params.variables));
		if (isPromiseLike(result)) {
			await result;
		}
		throw new Error(`Generated query '${functionName}' completed without executing a database call.`);
	} catch (error: unknown) {
		if (error instanceof CapturedQueryError) {
			return {
				...params.baseResolved,
				executableSql: error.capture.sql,
				bindValues: error.capture.bindValues
			};
		}
		throw error;
	}
}

async function loadGeneratedQueryModule(originalTs: string) {
	const js = tsBlankSpace(originalTs);
	const specifier = `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`;
	return dynamicImport(specifier);
}

function buildInvocationArgs(client: unknown, descriptor: RescriptQueryDescriptor, variables?: unknown): unknown[] {
	const args: unknown[] = [client];
	const vars = recordOrEmpty(variables);
	if (descriptor.kind === 'dynamic') {
		if (variables !== undefined) {
			args.push(variables);
		}
		return args;
	}
	if (descriptor.data.length > 0) {
		args.push(recordOrEmpty(vars.data));
		if (descriptor.parameters.length > 0 || descriptor.orderByColumns.length > 0) {
			args.push(recordOrEmpty(vars.params));
		}
		return args;
	}
	if (descriptor.parameters.length > 0 || descriptor.orderByColumns.length > 0) {
		args.push(variables ?? {});
	}
	return args;
}

function createCaptureClient(dialect: DatabaseClient['type']) {
	switch (dialect) {
		case 'mysql2':
			return {
				query(sqlOrOptions: string | { sql: string }, bindValues?: unknown[]) {
					throw new CapturedQueryError({
						sql: typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql,
						bindValues: Array.isArray(bindValues) ? bindValues : []
					});
				}
			};
		case 'pg':
			return {
				query(options: { text: string; values?: unknown[] }) {
					throw new CapturedQueryError({
						sql: options.text,
						bindValues: Array.isArray(options.values) ? options.values : []
					});
				}
			};
		case 'libsql':
			return {
				execute(sqlOrOptions: string | { sql: string; args?: unknown[] }) {
					throw new CapturedQueryError({
						sql: typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql,
						bindValues: typeof sqlOrOptions === 'string' ? [] : normalizeArguments(sqlOrOptions.args ?? [])
					});
				}
			};
		case 'better-sqlite3':
		case 'bun:sqlite':
		case 'd1':
			return {
				prepare(sql: string) {
					return createPreparedStatementCapture(sql);
				}
			};
	}
}

function createPreparedStatementCapture(sql: string) {
	const state: CapturedQuery = {
		sql,
		bindValues: []
	};
	return {
		raw(arg?: unknown) {
			if (typeof arg === 'boolean') {
				return this;
			}
			throw new CapturedQueryError({ sql: state.sql, bindValues: state.bindValues });
		},
		bind(...bindValues: unknown[]) {
			state.bindValues = normalizeArguments(bindValues);
			return this;
		},
		get(...args: unknown[]) {
			throw new CapturedQueryError({ sql: state.sql, bindValues: normalizeArguments(args) });
		},
		all(...args: unknown[]) {
			throw new CapturedQueryError({ sql: state.sql, bindValues: normalizeArguments(args) });
		},
		run(...args: unknown[]) {
			const bindValues = args.length > 0 ? normalizeArguments(args) : state.bindValues;
			throw new CapturedQueryError({ sql: state.sql, bindValues });
		},
		values(...args: unknown[]) {
			throw new CapturedQueryError({ sql: state.sql, bindValues: normalizeArguments(args) });
		},
		first(...args: unknown[]) {
			const bindValues = args.length > 0 ? normalizeArguments(args) : state.bindValues;
			throw new CapturedQueryError({ sql: state.sql, bindValues });
		}
	};
}

function normalizeArguments(args: unknown[]) {
	if (args.length === 0) {
		return [];
	}
	if (args.length === 1) {
		const [value] = args;
		if (value == null) {
			return [];
		}
		if (Array.isArray(value)) {
			return value;
		}
		return [value];
	}
	return args;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
	return typeof value === 'object' && value != null && 'then' in value && typeof (value as { then?: unknown }).then === 'function';
}
