import { parseSql as _parseSql } from '@wsporto/typesql-parser/postgres';
import { defaultOptions, PostgresTraverseResult, traverseSmt } from './traverse';
import { PostgresColumnSchema } from '../drivers/types';
import { Result, err, ok } from 'neverthrow';
import { CheckConstraintResult } from '../drivers/postgres';
import { UserFunctionSchema } from './types';
import { PostgresBuiltinFunctionSchema } from './builtin-functions';
import { TraverseOptions } from './traverse';

export function parseSql(
	sql: string,
	dbSchema: PostgresColumnSchema[],
	checkConstraints: CheckConstraintResult,
	userFunctions: UserFunctionSchema[],
	builtinFunctionsOrOptions: PostgresBuiltinFunctionSchema[] | TraverseOptions = [],
	maybeOptions = defaultOptions()
): PostgresTraverseResult {
	const { builtinFunctions, options } = normalizeFunctionResolutionArgs(builtinFunctionsOrOptions, maybeOptions);
	const parser = _parseSql(sql) as any;
	const syntaxErrors: string[] = [];
	if (typeof parser.removeErrorListeners === 'function' && typeof parser.addErrorListener === 'function') {
		parser.removeErrorListeners();
		parser.addErrorListener({
			syntaxError: (_recognizer: unknown, _offendingSymbol: unknown, line: number, column: number, message: string) => {
				syntaxErrors.push(`line ${line}:${column} ${message}`);
			},
			reportAmbiguity: () => { },
			reportAttemptingFullContext: () => { },
			reportContextSensitivity: () => { }
		});
	}

	const stmt = parser.stmt();
	if (syntaxErrors.length > 0 || parser._syntaxErrors > 0) {
		const message = syntaxErrors[0] ?? 'Postgres parser reported syntax errors';
		throw new Error(message);
	}

	const traverseResult = traverseSmt(stmt, dbSchema, checkConstraints, userFunctions, builtinFunctions, options);

	return {
		...traverseResult,
		columns: traverseResult.columns.map(({ column_key: _, record_type_name: __, record_type_schema: ___, ...rest }) => rest)
	};
}

export function safeParseSql(
	sql: string,
	dbSchema: PostgresColumnSchema[],
	checkConstraints: CheckConstraintResult,
	userFunctions: UserFunctionSchema[],
	builtinFunctionsOrOptions: PostgresBuiltinFunctionSchema[] | TraverseOptions = [],
	maybeOptions = defaultOptions()
): Result<PostgresTraverseResult, string> {
	try {
		const result = parseSql(sql, dbSchema, checkConstraints, userFunctions, builtinFunctionsOrOptions, maybeOptions);
		return ok(result);
	}
	catch (e) {
		const error = e as Error;
		return err(error.message);
	}
}

function normalizeFunctionResolutionArgs(
	builtinFunctionsOrOptions: PostgresBuiltinFunctionSchema[] | TraverseOptions,
	options: TraverseOptions
) {
	if (Array.isArray(builtinFunctionsOrOptions)) {
		return {
			builtinFunctions: builtinFunctionsOrOptions,
			options
		};
	}
	return {
		builtinFunctions: [] as PostgresBuiltinFunctionSchema[],
		options: builtinFunctionsOrOptions
	};
}
