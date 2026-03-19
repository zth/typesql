import { parseSql as _parseSql } from '@wsporto/typesql-parser/postgres';
import { defaultOptions, PostgresTraverseResult, traverseSmt } from './traverse';
import { PostgresColumnSchema } from '../drivers/types';
import { Result, err, ok } from 'neverthrow';
import { CheckConstraintResult } from '../drivers/postgres';
import { UserFunctionSchema } from './types';

export function parseSql(sql: string, dbSchema: PostgresColumnSchema[], checkConstraints: CheckConstraintResult, userFunctions: UserFunctionSchema[], options = defaultOptions()): PostgresTraverseResult {
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

	const traverseResult = traverseSmt(stmt, dbSchema, checkConstraints, userFunctions, options);

	return {
		...traverseResult,
		columns: traverseResult.columns.map(({ column_key: _, ...rest }) => rest)
	};
}

export function safeParseSql(sql: string, dbSchema: PostgresColumnSchema[], checkConstraints: CheckConstraintResult, userFunctions: UserFunctionSchema[], options = defaultOptions()): Result<PostgresTraverseResult, string> {
	try {
		const result = parseSql(sql, dbSchema, checkConstraints, userFunctions, options);
		return ok(result);
	}
	catch (e) {
		const error = e as Error;
		return err(error.message);
	}
}
