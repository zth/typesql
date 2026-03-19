import { type Either, left, right } from 'fp-ts/lib/Either';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Database as LibSqlDatabase } from 'libsql';
import type { ColumnInfo, ColumnSchema } from '../mysql-query-analyzer/types';
import type { ParameterDef, SchemaDef, TypeSqlError } from '../types';
import { preprocessSql } from '../describe-query';
import { countQuestionMarkParams, detectQueryType } from '../sql-query-type';

export type NativeSqliteDatabase = DatabaseType | LibSqlDatabase;

type NativeColumnDefinition = {
	name: string;
	column: string | null;
	table: string | null;
	database: string | null;
	type: string | null;
};

export function createDegradedSchemaDefinition(sql: string, dbSchema: ColumnSchema[], db: NativeSqliteDatabase, cause: TypeSqlError): Either<TypeSqlError, SchemaDef> {
	try {
		const { sql: processedSql, namedParameters } = preprocessSql(sql, 'sqlite');
		//@ts-ignore
		const statement = db.prepare(processedSql);
		const columns = typeof statement.columns === 'function'
			? (statement.columns() as NativeColumnDefinition[])
			: [];
		const queryType = detectQueryType(processedSql, 'sqlite') ?? (columns.length > 0 ? 'Select' : 'Update');
		const parameterNames = namedParameters.map(param => param.paramName);
		const fallbackParameterNames = parameterNames.length > 0
			? parameterNames
			: Array.from({ length: countQuestionMarkParams(processedSql, 'sqlite') }, (_value, index) => `param${index + 1}`);
		const schemaDef: SchemaDef = {
			sql: processedSql,
			queryType,
			multipleRowsResult: queryType === 'Select',
			columns: createDegradedColumns(columns, dbSchema),
			parameters: fallbackParameterNames.map((name): ParameterDef => ({
				name,
				columnType: 'any',
				notNull: false
			})),
			analysis: {
				mode: 'degraded',
				diagnostics: [
					{
						code: 'sqlite.degraded_fallback',
						message: cause.description
					}
				]
			}
		};
		if (queryType !== 'Select' && columns.length > 0) {
			schemaDef.returning = true;
		}
		return right(schemaDef);
	} catch (error) {
		const err = error as Error;
		return left({
			name: err.name,
			description: err.message
		});
	}
}

function createDegradedColumns(columns: NativeColumnDefinition[], dbSchema: ColumnSchema[]): ColumnInfo[] {
	return columns.map((column) => {
		const schemaColumn = dbSchema.find((schema) => schema.table === (column.table || '') && schema.column === (column.column || ''));
		return {
			name: column.name,
			type: schemaColumn?.column_type ?? mapDeclaredSqliteType(column.type),
			notNull: schemaColumn?.notNull ?? false,
			table: column.table || ''
		};
	});
}

function mapDeclaredSqliteType(type: string | null): ColumnInfo['type'] {
	if (type == null || type.trim() === '') {
		return 'any';
	}
	const normalized = type.toUpperCase();
	if (normalized === 'BOOLEAN') {
		return 'BOOLEAN';
	}
	if (normalized.includes('DATE') && normalized.includes('TIME')) {
		return 'DATE_TIME';
	}
	if (normalized === 'DATE') {
		return 'DATE';
	}
	if (normalized.includes('INT')) {
		return 'INTEGER';
	}
	if (normalized.includes('CHAR') || normalized.includes('CLOB') || normalized.includes('TEXT')) {
		return 'TEXT';
	}
	if (normalized.includes('BLOB')) {
		return 'BLOB';
	}
	if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) {
		return 'REAL';
	}
	if (normalized.includes('NUM') || normalized.includes('DEC')) {
		return 'NUMERIC';
	}
	return 'any';
}
