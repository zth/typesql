import { isLeft } from 'fp-ts/lib/Either';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ParameterOrJSON } from 'postgres';
import { recordOrEmpty } from '../cli-io';
import { parseSql as parseMySqlSql, preprocessSql } from '../describe-query';
import type { ColumnInfo, DynamicSqlInfoResult, DynamicSqlInfoResult2 } from '../mysql-query-analyzer/types';
import { describeQuery as describePostgresQuery } from '../postgres-query-analyzer/describe';
import type { PostgresColumnInfo, PostgresParameterDef, PostgresSchemaDef } from '../postgres-query-analyzer/types';
import { replaceOrderByParamWithPlaceholder } from '../postgres-query-analyzer/util';
import { parseSql as parseSqliteSql } from '../sqlite-query-analyzer/parser';
import type { PostgresSchemaInfo, SchemaInfo } from '../schema-info';
import type { DatabaseClient, ParameterDef, QueryType } from '../types';
import {
	type JsonSchema,
	arraySchema,
	enumSchema,
	nullableSchema,
	objectSchema,
	propertyFromSchema
} from './schemas';
import { requirePostgresSchemaInfo, requireStandardSchemaInfo } from './schema-guards';

export type GenericParameter = {
	name: string;
	dbType: string;
	notNull: boolean;
	path: string;
	listExpansion: boolean;
	driverArray: boolean;
	required: boolean;
	scope: 'params' | 'data';
};

export type GenericColumn = {
	name: string;
	dbType: string;
	notNull: boolean;
};

type StaticDescriptor = {
	kind: 'static';
	dialect: DatabaseClient['type'];
	sourceSql: string;
	preparedSql: string;
	queryType: QueryType | string;
	multipleRowsResult: boolean;
	parameters: GenericParameter[];
	data: GenericParameter[];
	orderByColumns: string[];
	columns: GenericColumn[];
};

type DynamicDescriptor = {
	kind: 'dynamic';
	dialect: DatabaseClient['type'];
	sourceSql: string;
	preparedSql: string;
	queryType: QueryType | string;
	multipleRowsResult: boolean;
	parameters: GenericParameter[];
	orderByColumns: string[];
	columns: GenericColumn[];
	paramsRequired: boolean;
};

export type RescriptQueryDescriptor = StaticDescriptor | DynamicDescriptor;

export type RescriptQueryCheck = {
	descriptor: RescriptQueryDescriptor;
	paramOrder: string[];
	variablesSchema: JsonSchema;
	exampleVariables: unknown;
	metadata: {
		isDynamic: boolean;
		hasOrderBy: boolean;
		multipleRowsResult: boolean;
		requiresVariablesForExplain: boolean;
	};
};

export type ResolvedQuery = {
	descriptor: RescriptQueryDescriptor;
	variablesSchema: JsonSchema;
	exampleVariables: unknown;
	paramOrder: string[];
	resolved: boolean;
	executableSql: string | null;
	bindValues: unknown[] | null;
	missingVariables: string[];
};

type ExecuteResult =
	| { rows: unknown[] }
	| { summary: Record<string, unknown> };

type MySqlQueryResult = ResultSetHeader | RowDataPacket[] | RowDataPacket[][];
type PostgresBindValue = ParameterOrJSON<never>;
type LibSqlExecuteResult = {
	rows: unknown[];
	rowsAffected: number;
	lastInsertRowid: number | bigint | null;
};
type LibSqlExecutor = {
	execute(statement: { sql: string; args?: unknown[] }): Promise<LibSqlExecuteResult>;
};
type SqliteStatement = {
	all(params?: unknown): unknown[];
	run(params?: unknown): Record<string, unknown>;
};

export async function checkRescriptQuery(
	dbClient: DatabaseClient,
	schemaInfo: SchemaInfo | PostgresSchemaInfo,
	sql: string
): Promise<RescriptQueryCheck> {
	const descriptor = await describeRescriptQuery(dbClient, schemaInfo, sql);
	const variablesSchema = buildVariablesSchema(descriptor);
	const exampleVariables = propertyFromSchema(variablesSchema);
	return {
		descriptor,
		paramOrder: symbolicParamOrder(descriptor),
		variablesSchema,
		exampleVariables,
		metadata: {
			isDynamic: descriptor.kind === 'dynamic',
			hasOrderBy: descriptor.orderByColumns.length > 0,
			multipleRowsResult: descriptor.multipleRowsResult,
			requiresVariablesForExplain: descriptor.kind === 'dynamic' || descriptor.parameters.some((param) => param.required || param.listExpansion)
		}
	};
}

export async function describeRescriptQuery(
	dbClient: DatabaseClient,
	schemaInfo: SchemaInfo | PostgresSchemaInfo,
	sql: string
): Promise<RescriptQueryDescriptor> {
	if (dbClient.type === 'mysql2') {
		const parseResult = await parseMySqlSql(dbClient, sql);
		if (isLeft(parseResult)) {
			throw new Error(parseResult.left.description);
		}
		const schemaDef = parseResult.right;
		return fromMySqlSchemaDef(sql, schemaDef);
	}
	if (dbClient.type === 'pg') {
		const result = await describePostgresQuery(dbClient.client, sql, requirePostgresSchemaInfo(schemaInfo));
		if (result.isErr()) {
			throw new Error(result.error.description);
		}
		return fromPostgresSchemaDef(sql, result.value);
	}
	const sqliteResult = parseSqliteSql(sql, requireStandardSchemaInfo(schemaInfo).columns);
	if (isLeft(sqliteResult)) {
		throw new Error(sqliteResult.left.description);
	}
	return fromSqliteSchemaDef(sql, sqliteResult.right, dbClient.type);
}

export function inspectRescriptQuery(descriptor: RescriptQueryDescriptor, variables?: unknown): ResolvedQuery {
	const variablesSchema = buildVariablesSchema(descriptor);
	return inspectCheckedRescriptQuery(
		{
			descriptor,
			variablesSchema,
			exampleVariables: propertyFromSchema(variablesSchema),
			paramOrder: symbolicParamOrder(descriptor)
		},
		variables
	);
}

export function inspectCheckedRescriptQuery(
	check: Pick<RescriptQueryCheck, 'descriptor' | 'variablesSchema' | 'exampleVariables' | 'paramOrder'>,
	variables?: unknown
): ResolvedQuery {
	const { descriptor, variablesSchema, exampleVariables, paramOrder } = check;
	const staticallyResolvedWithoutVariables =
		descriptor.kind === 'static' &&
		descriptor.parameters.length === 0 &&
		descriptor.data.length === 0 &&
		descriptor.orderByColumns.length === 0;
	if (variables === undefined) {
		return {
			descriptor,
			variablesSchema,
			exampleVariables,
			paramOrder,
			resolved: staticallyResolvedWithoutVariables,
			executableSql: staticallyResolvedWithoutVariables ? descriptor.preparedSql : null,
			bindValues: staticallyResolvedWithoutVariables ? [] : null,
			missingVariables: requiredVariablePaths(descriptor)
		};
	}
	const missingVariables = descriptor.kind === 'static'
		? collectMissingStaticVariables(descriptor, variables)
		: collectMissingDynamicVariables(descriptor, variables);
	return {
		descriptor,
		variablesSchema,
		exampleVariables,
		paramOrder,
		resolved: missingVariables.length === 0,
		executableSql: null,
		bindValues: null,
		missingVariables
	};
}

export async function explainRescriptQuery(
	dbClient: DatabaseClient,
	resolved: ResolvedQuery,
	analyze: boolean
): Promise<unknown> {
	if (!resolved.resolved || resolved.executableSql == null) {
		throw new Error('Query could not be resolved. Supply variables or use `check` first.');
	}
	const bindValues = resolved.bindValues || [];
	switch (dbClient.type) {
		case 'mysql2': {
			const explainSql = analyze ? `EXPLAIN ANALYZE ${resolved.executableSql}` : `EXPLAIN FORMAT=JSON ${resolved.executableSql}`;
			const [rows] = await dbClient.client.query<MySqlQueryResult>({ sql: explainSql, rowsAsArray: false }, bindValues);
			return rows;
		}
		case 'pg': {
			const explainSql = analyze
				? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${resolved.executableSql}`
				: `EXPLAIN (FORMAT JSON) ${resolved.executableSql}`;
			return await dbClient.client.unsafe(explainSql, asPostgresBindValues(bindValues));
		}
		case 'libsql': {
			const explainSql = `EXPLAIN QUERY PLAN ${resolved.executableSql}`;
			const result = await asLibSqlExecutor(dbClient.client).execute({ sql: explainSql, args: bindValues });
			return result.rows;
		}
		case 'better-sqlite3':
		case 'bun:sqlite':
		case 'd1': {
			const explainSql = `EXPLAIN QUERY PLAN ${resolved.executableSql}`;
			return asSqliteStatement(dbClient.client.prepare(explainSql)).all(bindValues);
		}
	}
}

export async function execRescriptQuery(dbClient: DatabaseClient, resolved: ResolvedQuery): Promise<ExecuteResult> {
	if (!resolved.resolved || resolved.executableSql == null) {
		throw new Error('Query could not be resolved. Supply variables or use `check` first.');
	}
	const bindValues = resolved.bindValues || [];
	const queryType = resolved.descriptor.queryType;
	switch (dbClient.type) {
		case 'mysql2': {
			const [rows] = await dbClient.client.query<MySqlQueryResult>({ sql: resolved.executableSql, rowsAsArray: false }, bindValues);
			if (queryType === 'Select') {
				return { rows: Array.isArray(rows) ? rows : [] };
			}
			return { summary: recordOrEmpty(rows) };
		}
		case 'pg': {
			const result = await dbClient.client.unsafe(resolved.executableSql, asPostgresBindValues(bindValues));
			if (queryType === 'Select' || resolved.descriptor.multipleRowsResult) {
				return { rows: postgresRows(result) };
			}
			return {
				summary: postgresSummary(result)
			};
		}
		case 'libsql': {
			const result = await asLibSqlExecutor(dbClient.client).execute({ sql: resolved.executableSql, args: bindValues });
			if (queryType === 'Select') {
				return { rows: result.rows };
			}
			return {
				summary: {
					rowsAffected: result.rowsAffected,
					lastInsertRowid: result.lastInsertRowid
				}
			};
		}
		case 'better-sqlite3':
		case 'bun:sqlite':
		case 'd1': {
			if (queryType === 'Select') {
				return { rows: asSqliteStatement(dbClient.client.prepare(resolved.executableSql)).all(bindValues) };
			}
			return {
				summary: asSqliteStatement(dbClient.client.prepare(resolved.executableSql)).run(bindValues)
			};
		}
	}
}

function asLibSqlExecutor(client: DatabaseClient['client']): LibSqlExecutor {
	return client as unknown as LibSqlExecutor;
}

function asPostgresBindValues(bindValues: unknown[]): PostgresBindValue[] {
	return bindValues as PostgresBindValue[];
}

function asSqliteStatement(statement: unknown): SqliteStatement {
	return statement as SqliteStatement;
}

function postgresSummary(result: unknown): Record<string, unknown> {
	const rowCount = typeof result === 'object' && result != null && 'count' in result && typeof result.count === 'number'
		? result.count
		: null;
	const command = typeof result === 'object' && result != null && 'command' in result && typeof result.command === 'string'
		? result.command
		: null;
	return {
		rowCount,
		command
	};
}

function postgresRows(result: unknown): unknown[] {
	return Array.isArray(result) ? result : [];
}

function fromMySqlSchemaDef(sourceSql: string, schemaDef: { queryType: QueryType; multipleRowsResult: boolean; parameters: ParameterDef[]; data?: ParameterDef[]; orderByColumns?: string[]; columns: ColumnInfo[]; dynamicSqlQuery?: DynamicSqlInfoResult; }): RescriptQueryDescriptor {
	const preparedSql = preprocessSql(sourceSql, 'mysql').sql;
	const parameters = schemaDef.parameters.map((param) => fromStandardParameter(param, 'params', 'mysql2'));
	const data = (schemaDef.data || []).map((param) => fromStandardParameter(param, 'data', 'mysql2'));
	const columns = schemaDef.columns.map((column) => ({ name: column.name, dbType: String(column.type), notNull: column.notNull }));
	if (schemaDef.dynamicSqlQuery) {
		return {
			kind: 'dynamic',
			dialect: 'mysql2',
			sourceSql,
			preparedSql,
			queryType: schemaDef.queryType,
			multipleRowsResult: schemaDef.multipleRowsResult,
			parameters,
			orderByColumns: schemaDef.orderByColumns || [],
			columns,
			paramsRequired: false
		};
	}
	return {
		kind: 'static',
		dialect: 'mysql2',
		sourceSql,
		preparedSql,
		queryType: schemaDef.queryType,
		multipleRowsResult: schemaDef.multipleRowsResult,
		parameters,
		data,
		orderByColumns: schemaDef.orderByColumns || [],
		columns
	};
}

function fromSqliteSchemaDef(
	sourceSql: string,
	schemaDef: { queryType: QueryType; multipleRowsResult: boolean; parameters: ParameterDef[]; data?: ParameterDef[]; orderByColumns?: string[]; columns: ColumnInfo[]; dynamicSqlQuery2?: DynamicSqlInfoResult2; },
	dialect: DatabaseClient['type']
): RescriptQueryDescriptor {
	const preparedSql = preprocessSql(sourceSql, 'sqlite').sql;
	const parameters = schemaDef.parameters.map((param) => fromStandardParameter(param, 'params', dialect));
	const data = (schemaDef.data || []).map((param) => fromStandardParameter(param, 'data', dialect));
	const columns = schemaDef.columns.map((column) => ({ name: column.name, dbType: String(column.type), notNull: column.notNull }));
	if (schemaDef.dynamicSqlQuery2) {
		return {
			kind: 'dynamic',
			dialect,
			sourceSql,
			preparedSql,
			queryType: schemaDef.queryType,
			multipleRowsResult: schemaDef.multipleRowsResult,
			parameters,
			orderByColumns: schemaDef.orderByColumns || [],
			columns,
			paramsRequired: parameters.length > 0
		};
	}
	return {
		kind: 'static',
		dialect,
		sourceSql,
		preparedSql,
		queryType: schemaDef.queryType,
		multipleRowsResult: schemaDef.multipleRowsResult,
		parameters,
		data,
		orderByColumns: schemaDef.orderByColumns || [],
		columns
	};
}

function fromPostgresSchemaDef(sourceSql: string, schemaDef: PostgresSchemaDef): RescriptQueryDescriptor {
	const preparedSql = preprocessStaticPostgresSql(sourceSql);
	const parameters = schemaDef.parameters.map((param) => fromPostgresParameter(param, 'params'));
	const data = (schemaDef.data || []).map((param) => fromPostgresParameter(param, 'data'));
	const columns = schemaDef.columns.map((column) => ({ name: column.name, dbType: stringifyPostgresType(column.type), notNull: column.notNull }));
	if (schemaDef.dynamicSqlQuery2) {
		return {
			kind: 'dynamic',
			dialect: 'pg',
			sourceSql,
			preparedSql,
			queryType: schemaDef.queryType,
			multipleRowsResult: schemaDef.multipleRowsResult,
			parameters,
			orderByColumns: schemaDef.orderByColumns || [],
			columns,
			paramsRequired: parameters.length > 0
		};
	}
	return {
		kind: 'static',
		dialect: 'pg',
		sourceSql,
		preparedSql,
		queryType: schemaDef.queryType,
		multipleRowsResult: schemaDef.multipleRowsResult,
		parameters,
		data,
		orderByColumns: schemaDef.orderByColumns || [],
		columns
	};
}

function fromStandardParameter(param: ParameterDef, scope: 'params' | 'data', dialect: DatabaseClient['type']): GenericParameter {
	const dbType = String(param.columnType);
	const listExpansion = dialect !== 'pg' && dbType.endsWith('[]');
	return {
		name: param.name,
		dbType,
		notNull: param.notNull,
		path: `${scope}.${param.name}`,
		listExpansion,
		driverArray: !listExpansion && dbType.endsWith('[]'),
		required: true,
		scope
	};
}

function fromPostgresParameter(param: PostgresParameterDef, scope: 'params' | 'data'): GenericParameter {
	const dbType = String(param.type);
	const listExpansion = dbType.endsWith('[]') && !dbType.startsWith('_');
	return {
		name: param.name,
		dbType,
		notNull: param.notNull,
		path: `${scope}.${param.name}`,
		listExpansion,
		driverArray: dbType.startsWith('_'),
		required: true,
		scope
	};
}

function stringifyPostgresType(type: PostgresColumnInfo['type']): string {
	if (typeof type === 'string') {
		return type;
	}
	return 'json';
}

function preprocessStaticPostgresSql(sourceSql: string): string {
	const orderByResult = replaceOrderByParamWithPlaceholder(sourceSql);
	return preprocessSql(orderByResult.sql, 'postgres').sql;
}

function collectMissingStaticVariables(descriptor: StaticDescriptor, variables: unknown): string[] {
	const vars = recordOrEmpty(variables);
	const missing: string[] = [];
	if (descriptor.data.length > 0) {
		const data = recordOrEmpty(vars.data);
		for (const param of descriptor.data) {
			if (!(param.name in data) && param.required) {
				missing.push(`data.${param.name}`);
			}
		}
	}
	const paramsContainer = descriptor.data.length > 0 ? recordOrEmpty(vars.params) : vars;
	for (const param of descriptor.parameters) {
		if (!(param.name in paramsContainer) && param.required) {
			missing.push(staticParameterPath(descriptor, param));
		}
	}
	if (descriptor.orderByColumns.length > 0) {
		const paramsRecord = descriptor.data.length > 0 ? recordOrEmpty(vars.params) : vars;
		if (!Array.isArray(paramsRecord.orderBy) || paramsRecord.orderBy.length === 0) {
			missing.push(staticOrderByPath(descriptor));
		}
	}
	return missing;
}

function collectMissingDynamicVariables(descriptor: DynamicDescriptor, variables: unknown): string[] {
	const vars = recordOrEmpty(variables);
	const missing: string[] = [];
	if (descriptor.paramsRequired && !('params' in vars)) {
		missing.push('params');
	}
	const params = recordOrEmpty(vars.params);
	if (descriptor.paramsRequired) {
		for (const param of descriptor.parameters) {
			if (!(param.name in params) && param.notNull) {
				missing.push(`params.${param.name}`);
			}
		}
	}
	if (descriptor.orderByColumns.length > 0) {
		if (!Array.isArray(vars.orderBy) || vars.orderBy.length === 0) {
			missing.push('orderBy');
		}
	}
	return missing;
}

function symbolicParamOrder(descriptor: RescriptQueryDescriptor): string[] {
	if (descriptor.kind === 'dynamic') {
		return [];
	}
	const order: string[] = [];
	for (const param of descriptor.data) {
		order.push(staticParameterPath(descriptor, param) + (param.listExpansion ? '[]' : ''));
	}
	for (const param of descriptor.parameters) {
		order.push(staticParameterPath(descriptor, param) + (param.listExpansion ? '[]' : ''));
	}
	if (descriptor.orderByColumns.length > 0) {
		order.push(staticOrderByPath(descriptor));
	}
	return order;
}

function requiredVariablePaths(descriptor: RescriptQueryDescriptor): string[] {
	if (descriptor.kind === 'dynamic') {
		const result: string[] = [];
		if (descriptor.paramsRequired) {
			result.push('params');
			for (const param of descriptor.parameters) {
				if (param.notNull) {
					result.push(`params.${param.name}`);
				}
			}
		}
		if (descriptor.orderByColumns.length > 0) {
			result.push('orderBy');
		}
		return result;
	}
	return symbolicParamOrder(descriptor);
}

export function buildVariablesSchema(descriptor: RescriptQueryDescriptor): JsonSchema {
	if (descriptor.kind === 'dynamic') {
		return buildDynamicVariablesSchema(descriptor);
	}
	return buildStaticVariablesSchema(descriptor);
}

function buildStaticVariablesSchema(descriptor: StaticDescriptor): JsonSchema {
	const paramsProperties: Record<string, JsonSchema> = {};
	const paramsRequired: string[] = [];
	for (const param of descriptor.parameters) {
		paramsProperties[param.name] = schemaForParameter(param);
		if (param.notNull) {
			paramsRequired.push(param.name);
		}
	}
	if (descriptor.orderByColumns.length > 0) {
		paramsProperties.orderBy = arraySchema(orderByItemSchema(descriptor.orderByColumns), 1);
		paramsRequired.push('orderBy');
	}
	if (descriptor.data.length > 0) {
		const dataProperties: Record<string, JsonSchema> = {};
		const dataRequired: string[] = [];
		for (const param of descriptor.data) {
			dataProperties[param.name] = schemaForParameter(param);
			if (param.required) {
				dataRequired.push(param.name);
			}
		}
		const topLevelProperties: Record<string, JsonSchema> = {
			data: objectSchema(dataProperties, dataRequired)
		};
		const required = ['data'];
		if (Object.keys(paramsProperties).length > 0) {
			topLevelProperties.params = objectSchema(paramsProperties, paramsRequired);
			required.push('params');
		}
		return {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			...objectSchema(topLevelProperties, required)
		};
	}
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		...objectSchema(paramsProperties, paramsRequired)
	};
}

function buildDynamicVariablesSchema(descriptor: DynamicDescriptor): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];
	if (descriptor.parameters.length > 0) {
		const paramProperties: Record<string, JsonSchema> = {};
		const paramRequired: string[] = [];
		for (const param of descriptor.parameters) {
			paramProperties[param.name] = schemaForParameter(param);
			if (descriptor.paramsRequired && param.notNull) {
				paramRequired.push(param.name);
			}
		}
		properties.params = objectSchema(paramProperties, paramRequired);
		if (descriptor.paramsRequired) {
			required.push('params');
		}
	}
	if (descriptor.columns.length > 0) {
		const selectProperties: Record<string, JsonSchema> = {};
		for (const column of descriptor.columns) {
			selectProperties[column.name] = { type: 'boolean' };
		}
		properties.select = objectSchema(selectProperties, []);
		properties.where = arraySchema(whereConditionSchema(descriptor));
	}
	if (descriptor.orderByColumns.length > 0) {
		properties.orderBy = arraySchema(orderByItemSchema(descriptor.orderByColumns), 1);
		required.push('orderBy');
	}
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		...objectSchema(properties, required)
	};
}

function whereConditionSchema(descriptor: DynamicDescriptor): JsonSchema {
	const variants: JsonSchema[] = [];
	for (const column of descriptor.columns) {
		const baseValue = schemaForDbType(column.dbType, false);
		const nullableValue = nullableSchema(baseValue);
		const listValue = arraySchema(baseValue);
		const betweenValue = {
			type: 'array',
			prefixItems: [nullableValue, nullableValue],
			minItems: 2,
			maxItems: 2
		};
		const compareOps = isStringLikeType(column.dbType)
			? ['=', '<>', '>', '<', '>=', '<=', 'LIKE']
			: ['=', '<>', '>', '<', '>=', '<='];
		variants.push(objectSchema({
			column: { const: column.name },
			op: enumSchema(compareOps),
			value: nullableValue
		}, ['column', 'op', 'value']));
		variants.push(objectSchema({
			column: { const: column.name },
			op: enumSchema(['IN', 'NOT IN']),
			value: listValue
		}, ['column', 'op', 'value']));
		variants.push(objectSchema({
			column: { const: column.name },
			op: enumSchema(['BETWEEN']),
			value: betweenValue
		}, ['column', 'op', 'value']));
	}
	return {
		oneOf: variants
	};
}

function orderByItemSchema(columns: string[]): JsonSchema {
	return objectSchema(
		{
			column: enumSchema(columns),
			direction: enumSchema(['asc', 'desc'])
		},
		['column', 'direction']
	);
}

function schemaForParameter(param: GenericParameter): JsonSchema {
	let schema = schemaForDbType(param.dbType, param.listExpansion || param.driverArray);
	if (!param.notNull && !param.listExpansion) {
		schema = nullableSchema(schema);
	}
	return {
		...schema,
		'x-typesql-dbType': param.dbType,
		...(param.listExpansion ? { 'x-typesql-listExpansion': true } : {}),
		...(param.driverArray ? { 'x-typesql-driverArray': true } : {})
	};
}

function schemaForDbType(dbType: string, forceArray: boolean): JsonSchema {
	if (forceArray) {
		const base = schemaForDbType(baseTypeName(dbType), false);
		return {
			type: 'array',
			items: base,
			...(isListExpansionType(dbType) ? { minItems: 1 } : {})
		};
	}
	if (dbType.startsWith('enum(')) {
		return {
			type: 'string',
			enum: dbType.substring(dbType.indexOf('(') + 1, dbType.lastIndexOf(')')).split(',').map((item) => item.replace(/^'+|'+$/g, '').replace(/^"+|"+$/g, ''))
		};
	}
	const type = dbType.toLowerCase();
	if (type === 'integer' || type === 'int' || type === 'int2' || type === 'int4' || type === 'smallint' || type === 'mediumint' || type === 'year') {
		return { type: 'integer' };
	}
	if (type === 'int8' || type === 'bigint') {
		return {
			oneOf: [
				{ type: 'integer' },
				{ type: 'string', pattern: '^-?[0-9]+$' }
			]
		};
	}
	if (type === 'real' || type === 'numeric' || type === 'float' || type === 'float4' || type === 'float8' || type === 'double' || type === 'double precision') {
		return { type: 'number' };
	}
	if (type === 'decimal') {
		return {
			oneOf: [{ type: 'number' }, { type: 'string' }]
		};
	}
	if (type === 'bool' || type === 'boolean' || type === 'bit') {
		return { type: 'boolean' };
	}
	if (type === 'date') {
		return { type: 'string', format: 'date' };
	}
	if (type === 'date_time' || type === 'datetime' || type === 'timestamp' || type === 'timestamptz' || type === 'timestamp2' || type === 'datetime2' || type === 'time' || type === 'time2' || type === 'timetz') {
		return { type: 'string', format: 'date-time' };
	}
	if (type === 'blob' || type === 'bytea' || type === 'binary' || type === 'varbinary') {
		return { type: 'string', contentEncoding: 'base64' };
	}
	if (type === 'json' || type === 'jsonb') {
		return {};
	}
	return { type: 'string' };
}

function baseTypeName(dbType: string) {
	if (dbType.startsWith('_')) {
		return dbType.slice(1);
	}
	if (dbType.endsWith('[]')) {
		return dbType.slice(0, -2);
	}
	return dbType;
}

function isListExpansionType(dbType: string) {
	return dbType.endsWith('[]') && !dbType.startsWith('_');
}

function isStringLikeType(dbType: string) {
	const type = dbType.toLowerCase();
	return !(type === 'integer' || type === 'int' || type === 'int2' || type === 'int4' || type === 'smallint' || type === 'mediumint' || type === 'year' || type === 'int8' || type === 'bigint' || type === 'real' || type === 'numeric' || type === 'float' || type === 'float4' || type === 'float8' || type === 'double' || type === 'bool' || type === 'boolean' || type === 'bit');
}

function staticParameterPath(descriptor: StaticDescriptor, param: GenericParameter): string {
	if (param.scope === 'data') {
		return `data.${param.name}`;
	}
	return descriptor.data.length > 0 ? `params.${param.name}` : param.name;
}

function staticOrderByPath(descriptor: StaticDescriptor): string {
	return descriptor.data.length > 0 ? 'params.orderBy' : 'orderBy';
}
