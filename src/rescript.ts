import type { SchemaInfo, PostgresSchemaInfo } from './schema-info';
import { generateTypeScriptContent, generateTsCodeForMySQL, generateTsDescriptor } from './code-generator';
import { generateCode as generatePgTsCode } from './code-generator2';
import { parseSql } from './describe-query';
import { isLeft } from 'fp-ts/lib/Either';
import type { BunDialect, D1Dialect, DatabaseClient, LibSqlClient, SQLiteClient, SQLiteDialect, PgDielect, MySqlDialect } from './types';
import { SQLiteType, type PostgresType } from './sqlite-query-analyzer/types';
import { TsType, mapper as mapperMySQL, MySqlType } from './mysql-mapping';
import { mapper as mapperSqlite } from './drivers/sqlite';
import { mapper as mapperPostgres } from './dialects/postgres';
import ts from 'typescript';
import tsBlankSpace from 'ts-blank-space';
import dprint from 'dprint-node';

const mapSqlite: (sqliteType: SQLiteType, client: SQLiteClient) => string = (sqliteType, client) => {
	switch (sqliteType) {
		case 'INTEGER':
			return 'int';
		case 'INTEGER[]':
			return 'int[]';
		case 'TEXT':
			return 'string';
		case 'TEXT[]':
			return 'string[]';
		case 'NUMERIC':
			return 'float';
		case 'NUMERIC[]':
			return 'float[]';
		case 'REAL':
			return 'float';
		case 'REAL[]':
			return 'float[]';
		case 'DATE':
			return 'Date';
		case 'DATE_TIME':
			return 'Date';
		case 'BLOB':
			return client === 'better-sqlite3' ? 'Uint8Array' : 'ArrayBuffer';
		case 'BOOLEAN':
			return 'bool';
	}
	if (sqliteType.startsWith('ENUM')) {
		const enumValues = sqliteType.substring(sqliteType.indexOf('(') + 1, sqliteType.indexOf(')'));
		// Emit a TS string-literal union so it becomes polymorphic variants in ReScript
		return enumValues.split(',').join(' | ');
	}
	console.warn(`SQLite type '${sqliteType}' not explicitly mapped -> defaulting to 'any'`);
	return 'any';
};

function setupMappers() {
	mapperSqlite.mapColumnType = (sqliteType, client) => mapSqlite(sqliteType, client) as TsType;
	mapperMySQL.converToTsType = (t: MySqlType | 'any') => mapMySQL(t) as TsType;
	mapperPostgres.mapColumnType = (t: PostgresType, json?: boolean) => mapPostgres(t, json) as TsType;
}

const mapMySQL = (mySqlType: MySqlType | 'any'): string => {
	// Favor ReScript-friendly scalars: int, float, bool
	switch (mySqlType) {
		case 'tinyint':
		case 'smallint':
		case 'int':
		case 'mediumint':
		case 'bigint':
		case 'year':
			return 'int';
		case 'tinyint[]':
		case 'smallint[]':
		case 'int[]':
		case 'mediumint[]':
		case 'bigint[]':
		case 'year[]':
			return 'int[]';
		case 'float':
		case 'double':
			return 'float';
		case 'float[]':
		case 'double[]':
			return 'float[]';
		case 'decimal':
			return 'string';
		case 'decimal[]':
			return 'string[]';
		case 'varchar':
		case 'varbinary':
		case 'geometry':
		case 'tinytext':
		case 'mediumtext':
		case 'longtext':
		case 'text':
		case 'binary':
		case 'char':
			return 'string';
		case 'varchar[]':
		case 'char[]':
			return 'string[]';
		case 'timestamp':
		case 'timestamp2':
		case 'date':
		case 'newdate':
		case 'datetime':
		case 'datetime2':
		case 'time':
		case 'time2':
			return 'Date';
		case 'bit':
			return 'bool';
		case 'bit[]':
			return 'bool[]';
		case 'json':
			return 'Object';
		case 'tinyblob':
		case 'mediumblob':
		case 'longblob':
		case 'blob':
			return 'Uint8Array';
		case 'set':
			return 'any';
		default: {
			if (typeof mySqlType === 'string' && mySqlType.startsWith('enum(')) {
				const enumValues = mySqlType.substring(mySqlType.indexOf('(') + 1, mySqlType.indexOf(')'));
				return enumValues.split(',').join(' | ');
			}
			return 'any';
		}
	}
};

const mapPostgres: (postgresType: PostgresType, json?: boolean) => string = (postgresType, json = false) => {
	if (typeof postgresType === 'object') {
		return 'any';
	}
	if (postgresType.startsWith('enum(')) {
		const enumValues = postgresType.substring(postgresType.indexOf('(') + 1, postgresType.indexOf(')'));
		return enumValues.split(',').join(' | ');
	}
	switch (postgresType) {
		case 'bool':
			return 'bool';
		case '_bool':
		case 'bool[]':
			return 'bool[]';
		case 'int2':
		case 'int4':
			return 'int';
		case '_int2':
		case 'int2[]':
		case '_int4':
		case 'int4[]':
			return 'int[]';
		case 'float4':
		case 'float8':
			return 'float';
		case '_float4':
		case 'float4[]':
		case '_float8':
		case 'float8[]':
			return 'float[]';
		case 'bytea':
			return json ? 'string' : 'ArrayBuffer';
		case '_bytea':
		case 'bytea[]':
			return json ? 'string[]' : 'ArrayBuffer[]';
		case 'char':
		case 'bpchar':
		case 'name':
		case 'text':
		case 'varchar':
		case 'uuid':
		case 'varbit':
		case 'interval':
		case 'time':
		case 'timetz':
		case 'tsvector':
		case 'tsquery':
		case 'jsonpath':
		case 'vector':
		case 'regproc':
		case 'oid':
		case 'tid':
		case 'xid':
		case 'cid':
		case 'oidvector':
		case 'xml':
		case 'point':
		case 'lseg':
		case 'path':
		case 'box':
		case 'polygon':
		case 'line':
		case 'cidr':
		case 'circle':
		case 'macaddr8':
		case 'money':
		case 'macaddr':
		case 'inet':
		case 'int4range':
		case 'int8range':
		case 'daterange':
		case 'numrange':
		case 'tsrange':
		case 'tstzrange':
		case 'aclitem':
		case 'cstring':
		case 'pg_node_tree':
			return 'string';
		case '_char':
		case 'char[]':
		case '_bpchar':
		case 'bpchar[]':
		case '_name':
		case 'name[]':
		case '_text':
		case 'text[]':
		case '_varchar':
		case 'varchar[]':
		case '_uuid':
		case 'uuid[]':
		case '_varbit':
		case 'varbit[]':
		case '_interval':
		case 'interval[]':
		case '_time':
		case 'time[]':
		case '_timetz':
		case 'timetz[]':
		case '_tsvector':
		case 'tsvector[]':
		case '_tsquery':
		case 'tsquery[]':
		case '_jsonpath':
		case 'jsonpath[]':
		case '_vector':
		case 'vector[]':
		case '_regproc':
		case 'regproc[]':
		case '_oid':
		case 'oid[]':
		case '_tid':
		case 'tid[]':
		case '_xid':
		case 'xid[]':
		case '_cid':
		case 'cid[]':
		case '_oidvector':
		case 'oidvector[]':
		case '_xml':
		case 'xml[]':
		case '_point':
		case 'point[]':
		case '_lseg':
		case 'lseg[]':
		case '_path':
		case 'path[]':
		case '_box':
		case 'box[]':
		case '_polygon':
		case 'polygon[]':
		case '_line':
		case 'line[]':
		case '_cidr':
		case 'cidr[]':
		case '_circle':
		case 'circle[]':
		case '_macaddr8':
		case 'macaddr8[]':
		case '_money':
		case 'money[]':
		case '_macaddr':
		case 'macaddr[]':
		case '_inet':
		case 'inet[]':
		case '_int4range':
		case 'int4range[]':
		case '_int8range':
		case 'int8range[]':
		case '_numrange':
		case 'numrange[]':
		case '_daterange':
		case 'daterange[]':
		case '_tsrange':
		case 'tsrange[]':
		case '_tstzrange':
		case 'tstzrange[]':
		case '_aclitem':
		case 'aclitem[]':
		case '_cstring':
		case 'cstring[]':
		case 'anyarray[]':
		case 'pg_node_tree[]':
			return 'string[]';
		case 'date':
		case 'timestamp':
		case 'timestamptz':
			return json ? 'string' : 'Date';
		case '_date':
		case 'date[]':
		case '_timestamp':
		case 'timestamp[]':
		case '_timestamptz':
		case 'timestamptz[]':
			return json ? 'string[]' : 'Date[]';
		case 'json':
		case 'jsonb':
			return 'JSON';
		case '_json':
		case 'json[]':
		case '_jsonb':
		case 'jsonb[]':
			return 'JSON[]';
		case 'int8':
			return 'bigint';
		case '_int8':
		case 'int8[]':
			return 'bigint[]';
		case 'unknown':
			return 'any';
		case 'null':
			return 'null';
	}
	return 'any';
};

// Type aliases we should not emit into ReScript output
const TYPE_ALIAS_IGNORE = new Set<string>(['WhereConditionResult']);

export type GenerateSqlOptions = {
	sql: string;
	queryName: string;
	isCrudFile?: boolean;
	databaseClient: SQLiteDialect | LibSqlClient | BunDialect | D1Dialect;
	schemaInfo: SchemaInfo;
};

function rescriptFromTs(
	tsContent: string,
	queryName: string,
	databaseClient: DatabaseClient['type']
): { rescript: string; originalTs: string } {
	const tsCleaned = tsContent.replace(/^\s*import\s+pg\s+from\s+['"]pg['"];?\s*\n?/gm, '').replace(/\bexport\s+/g, '');
	const ir = extractRescriptIRFromTypeScript(tsCleaned, queryName);
	const blankedJs = tsBlankSpace(tsCleaned);
	const formattedJs = dprint.format('generated.js', blankedJs, {
		lineWidth: 100,
		semiColons: 'asi',
		quoteStyle: 'alwaysSingle'
	});
	const rescript = printRescript(ir, databaseClient, { rawJs: formattedJs });
	return { rescript, originalTs: tsContent };
}

export async function generateReScriptFromSQLite(params: GenerateSqlOptions): Promise<{ rescript: string; originalTs: string }> {
	const { databaseClient, schemaInfo, queryName } = params;
	setupMappers();
	const generated = await generateTypeScriptContent({
		client: databaseClient,
		queryName,
		sqlContent: params.sql,
		schemaInfo,
		isCrudFile: params.isCrudFile ?? false
	});
	if (isLeft(generated)) {
		throw new Error(generated.left.description);
	}
	return rescriptFromTs(generated.right, queryName, databaseClient.type);
}

export type GeneratePostgresOptions = {
	sql: string;
	queryName: string;
	isCrudFile?: boolean;
	databaseClient: PgDielect;
	schemaInfo: PostgresSchemaInfo;
};

export async function generateReScriptFromPostgres(params: GeneratePostgresOptions): Promise<{ rescript: string; originalTs: string }> {
	const { databaseClient, schemaInfo, queryName } = params;
	setupMappers();
	const result = await generateTypeScriptContent({
		client: databaseClient,
		queryName,
		sqlContent: params.sql,
		schemaInfo,
		isCrudFile: params.isCrudFile ?? false
	});
	if (isLeft(result)) {
		throw new Error(result.left.description);
	}
	return rescriptFromTs(result.right, queryName, databaseClient.type);
}

export type GenerateMySQLOptions = {
	sql: string;
	queryName: string;
	isCrudFile?: boolean;
	databaseClient: MySqlDialect;
	schemaInfo: SchemaInfo;
};

export async function generateReScriptFromMySQL(params: GenerateMySQLOptions): Promise<{ rescript: string; originalTs: string }> {
	setupMappers();

	const { databaseClient, queryName } = params;
	const parsed = await parseSql(databaseClient, params.sql);
	if (isLeft(parsed)) {
		throw new Error(parsed.left.description);
	}

	const tsContent = await generateTypeScriptContent({
		client: databaseClient,
		queryName,
		sqlContent: params.sql,
		schemaInfo: params.schemaInfo,
		isCrudFile: params.isCrudFile ?? false
	});
	if (isLeft(tsContent)) {
		throw new Error(tsContent.left.description);
	}
	return rescriptFromTs(tsContent.right, queryName, databaseClient.type);
}

export type IRType =
	| { kind: 'int' | 'float' | 'string' | 'bool' | 'date' | 'bytes' | 'any' | 'bigint' }
	| { kind: 'array'; of: IRType }
	| { kind: 'promise'; of: IRType }
	| { kind: 'union'; of: IRType[] }
	| { kind: 'tuple'; elements: IRType[] }
	| { kind: 'object'; fields: IRField[] }
	| { kind: 'literal'; value: string | number | boolean | null | undefined }
	| { kind: 'ref'; name: string };

export type IRField = { name: string; type: IRType; optional?: boolean };

export type IRTypeDef = {
	name: string; // Original TS name e.g. SelectUsersParams
	role: 'Params' | 'Result' | 'Other';
	aliasOf: IRType; // Usually an object type for these
};

export type RescriptIR = {
	queryName: string; // e.g. selectUsers (logical base name)
	mainName: string; // function to expose as run (may be `${queryName}Nested`)
	pascalName: string; // e.g. SelectUsers
	types: IRTypeDef[]; // Extracted types we care about
	functions: IRFunction[]; // Functions with signatures and optional JS bodies
};

// Public entry: parse TS string and extract a minimal IR for ReScript printing
export function extractRescriptIRFromTypeScript(tsCode: string, queryName: string): RescriptIR {
	// Enable parent pointers so getText works reliably on nested nodes
	const source = ts.createSourceFile('generated.ts', tsCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const pascalName = toPascalCase(queryName);

	// Collect const literal arrays we care about (orderByColumns)
	const constStringArrays = collectConstStringArrayLiterals(source);

	const types: IRTypeDef[] = [];
	const functions: IRFunction[] = [];

	for (const stmt of source.statements) {
		if (ts.isTypeAliasDeclaration(stmt)) {
			const name = stmt.name.text;
			if (TYPE_ALIAS_IGNORE.has(name)) {
				continue;
			}
			const role: IRTypeDef['role'] = name.endsWith('Params')
				? name.startsWith(pascalName)
					? 'Params'
					: 'Other'
				: name.endsWith('Result')
					? name.startsWith(pascalName)
						? 'Result'
						: 'Other'
					: 'Other';
			// Capture all type aliases, not just Params/Result
			const aliasOf = typeNodeToIR(stmt.type, constStringArrays);
			types.push({ name, role, aliasOf });
		}
		// Collect const-based functions
		const fn = extractFunctionFromStatement(stmt, constStringArrays);
		if (fn) {
			functions.push(...(Array.isArray(fn) ? fn : [fn]));
		}
	}

	// Prefer nested function as main if available
	const nestedCandidate = `${queryName}Nested`;
	const hasNested = functions.some((f) => f.name === nestedCandidate);
	const mainName = hasNested ? nestedCandidate : queryName;

	return { queryName, mainName, pascalName, types, functions };
}

// Safely get full name for qualified type references like pg.Client
function getEntityNameText(name: ts.EntityName): string {
	if (ts.isIdentifier(name)) return name.text;
	return `${getEntityNameText(name.left)}.${name.right.text}`;
}

type ConstStringArrayMap = Map<string, string[]>;

function typeNodeToIR(node: ts.TypeNode, constStringArrays?: ConstStringArrayMap): IRType {
	if (ts.isTypeLiteralNode(node)) {
		const fields: IRField[] = node.members.filter(ts.isPropertySignature).map((m) => {
			const name = getPropertyName(m.name);
			const optional = m.questionToken != null;
			const typeNode = m.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
			return { name, optional, type: typeNodeToIR(typeNode, constStringArrays) };
		});
		return { kind: 'object', fields };
	}
	// Tuple types, e.g. ['id', StringOperator, int | null]
	if (ts.isTupleTypeNode(node)) {
		const elements = node.elements.map((el) => typeNodeToIR(el, constStringArrays));
		return { kind: 'tuple', elements };
	}
	if (ts.isArrayTypeNode(node)) {
		return { kind: 'array', of: typeNodeToIR(node.elementType, constStringArrays) };
	}
	if (ts.isUnionTypeNode(node)) {
		return { kind: 'union', of: node.types.map((t) => typeNodeToIR(t, constStringArrays)) };
	}
	// Handle typeof <ConstStringArray>[number] -> union of string literals
	if (ts.isIndexedAccessTypeNode(node)) {
		const obj = node.objectType;
		const idx = node.indexType;
		if (
			ts.isTypeQueryNode(obj) &&
			ts.isIdentifier(obj.exprName) &&
			(idx.kind === ts.SyntaxKind.NumberKeyword ||
				(ts.isTypeReferenceNode(idx) && ts.isIdentifier(idx.typeName) && idx.typeName.text === 'number'))
		) {
			const values = constStringArrays?.get(obj.exprName.text) || [];
			if (values.length > 0) {
				return { kind: 'union', of: values.map((v) => ({ kind: 'literal', value: v }) as IRType) };
			}
		}
	}
	if (ts.isTypeReferenceNode(node)) {
		const typeName = ts.isIdentifier(node.typeName) ? node.typeName.text : getEntityNameText(node.typeName);
		if (typeName === 'Date') return { kind: 'date' };
		if (typeName === 'Uint8Array' || typeName === 'ArrayBuffer') return { kind: 'bytes' };
		// Normalize scalar aliases our mapper might emit
		if (typeName === 'int') return { kind: 'int' };
		if (typeName === 'float') return { kind: 'float' };
		if (typeName === 'bool') return { kind: 'bool' };
		if (typeName === 'string') return { kind: 'string' };
		if (typeName === 'any' || typeName === 'unknown') {
			console.warn(`Encountered type reference '${typeName}' -> mapping to IR 'any' (${node.getText()})`);
			return { kind: 'any' };
		}
		// Handle generic arrays: Array<T> and array<T>
		if ((typeName === 'Array' || typeName === 'array') && node.typeArguments && node.typeArguments.length === 1) {
			return { kind: 'array', of: typeNodeToIR(node.typeArguments[0]!, constStringArrays) };
		}
		if (typeName === 'Promise' && node.typeArguments && node.typeArguments.length === 1) {
			return { kind: 'promise', of: typeNodeToIR(node.typeArguments[0]!, constStringArrays) };
		}
		return { kind: 'ref', name: typeName };
	}
	if (ts.isLiteralTypeNode(node)) {
		if (ts.isStringLiteral(node.literal)) return { kind: 'literal', value: node.literal.text };
		if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
		if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
		if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null };
	}
	if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: 'float' };
	if (node.kind === ts.SyntaxKind.BigIntKeyword) return { kind: 'bigint' };
	if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: 'bool' };
	if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: 'string' };
	if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null };
	if (node.kind === ts.SyntaxKind.UndefinedKeyword) return { kind: 'literal', value: undefined };
	if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
		return { kind: 'any' };
	}
	// Default fallback: treat as 'any' without logging here; printing decides if it matters.
	return { kind: 'any' };
}

function getPropertyName(name: ts.PropertyName | ts.BindingName): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return name.getText();
}

function toPascalCase(name: string): string {
	if (!name) return name;
	return name.charAt(0).toUpperCase() + name.slice(1);
}

// Function IR
export type IRFunctionParam = { name: string; type?: IRType; optional?: boolean };
export type IRFunction = {
	name: string;
	params: IRFunctionParam[];
	returnType?: IRType;
};

function extractFunctionFromStatement(stmt: ts.Statement, constStringArrays?: ConstStringArrayMap): IRFunction | IRFunction[] | undefined {
	if (ts.isFunctionDeclaration(stmt) && stmt.name) {
		const name = stmt.name.text;
		const params = (stmt.parameters || []).map((p) => paramToIRParam(p, constStringArrays));
		const returnType = stmt.type ? typeNodeToIRRef(stmt.type, constStringArrays) : undefined;
		return { name, params, returnType };
	}
	if (ts.isVariableStatement(stmt)) {
		const out: IRFunction[] = [];
		for (const decl of stmt.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name)) continue;
			const name = decl.name.text;
			const init = decl.initializer;
			if (init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))) {
				const params = (init.parameters || []).map((p) => paramToIRParam(p, constStringArrays));
				const returnType = init.type ? typeNodeToIRRef(init.type, constStringArrays) : undefined;
				out.push({ name, params, returnType });
			}
		}
		if (out.length > 0) return out;
	}
	return undefined;
}

function paramToIRParam(p: ts.ParameterDeclaration, constStringArrays?: ConstStringArrayMap): IRFunctionParam {
	const name = getPropertyName(p.name);
	const optional = p.questionToken != null;
	const type = p.type ? typeNodeToIRRef(p.type, constStringArrays) : undefined;
	return { name, optional, type };
}

// Similar to typeNodeToIR, but preserves references as refs instead of defaulting to 'any'
function typeNodeToIRRef(node: ts.TypeNode, constStringArrays?: ConstStringArrayMap): IRType {
	// Handle typeof <ConstStringArray>[number] -> union of string literals
	if (ts.isIndexedAccessTypeNode(node)) {
		const obj = node.objectType;
		const idx = node.indexType;
		if (
			ts.isTypeQueryNode(obj) &&
			ts.isIdentifier(obj.exprName) &&
			(idx.kind === ts.SyntaxKind.NumberKeyword ||
				(ts.isTypeReferenceNode(idx) && ts.isIdentifier(idx.typeName) && idx.typeName.text === 'number'))
		) {
			const values = constStringArrays?.get(obj.exprName.text) || [];
			if (values.length > 0) {
				return { kind: 'union', of: values.map((v) => ({ kind: 'literal', value: v }) as IRType) };
			}
		}
	}
	if (ts.isTypeReferenceNode(node)) {
		const typeName = ts.isIdentifier(node.typeName) ? node.typeName.text : getEntityNameText(node.typeName);
		if (typeName === 'Date') return { kind: 'date' };
		if (typeName === 'Uint8Array' || typeName === 'ArrayBuffer') return { kind: 'bytes' };
		if (typeName === 'int') return { kind: 'int' };
		if (typeName === 'float') return { kind: 'float' };
		if (typeName === 'bool') return { kind: 'bool' };
		if (typeName === 'string') return { kind: 'string' };
		if (typeName === 'any' || typeName === 'unknown') {
			return { kind: 'any' };
		}
		if ((typeName === 'Array' || typeName === 'array') && node.typeArguments && node.typeArguments.length === 1) {
			return { kind: 'array', of: typeNodeToIR(node.typeArguments[0]!, constStringArrays) };
		}
		if (typeName === 'Promise' && node.typeArguments && node.typeArguments.length === 1) {
			return { kind: 'promise', of: typeNodeToIR(node.typeArguments[0]!, constStringArrays) };
		}

		return { kind: 'ref', name: typeName };
	}
	// Preserve tuple structure as-is
	if (ts.isTupleTypeNode(node)) {
		return { kind: 'tuple', elements: node.elements.map((el) => typeNodeToIRRef(el, constStringArrays)) };
	}
	return typeNodeToIR(node, constStringArrays);
}

// Find and store literal values for specific const arrays, e.g. orderByColumns
function collectConstStringArrayLiterals(source: ts.SourceFile): ConstStringArrayMap {
	const map: ConstStringArrayMap = new Map();
	for (const stmt of source.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
		if (!isConst) continue;
		for (const decl of stmt.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name)) continue;
			const varName = decl.name.text;
			if (!decl.initializer) continue;
			let init: ts.Expression = decl.initializer as ts.Expression;
			// Unwrap "as const"
			while (ts.isAsExpression(init)) {
				init = init.expression;
			}
			if (ts.isArrayLiteralExpression(init)) {
				const values: string[] = [];
				for (const el of init.elements) {
					if (ts.isStringLiteral(el)) values.push(el.text);
				}
				if (values.length > 0) map.set(varName, values);
			}
		}
	}
	return map;
}

function encodeRawString(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
}

// ReScript printer and helpers
export function printRescript(ir: RescriptIR, clientType: DatabaseClient['type'], opts?: { rawJs?: string }): string {
	const lines: string[] = [];

	// Emit the entire JS (with types erased) as a single raw block
	if (opts?.rawJs && opts.rawJs.trim().length > 0) {
		const encoded = encodeRawString(opts.rawJs);
		lines.push(`%%raw("${encoded}")`);
		lines.push('');
	}
	// Emit all types in declaration order as a recursive chain: type rec ... and ...
	const allTypes = ir.types;
	if (allTypes.length > 0) {
		if (allTypes.length > 1) {
			lines.push('@@warning("-30")');
		}
		const first = allTypes[0]!;
		const firstName = lowerFirst(first.name);
		const firstCtx = {
			currentAliasName: first.name,
			paramsTopLevel: first.role === 'Params' || first.name.endsWith('Select') ? true : undefined
		} as const;
		const recFlag = allTypes.length > 1 ? 'rec ' : '';
		lines.push(`type ${recFlag}${firstName} = ${printRsType(first.aliasOf, clientType, ir, firstCtx)}`);
		for (let i = 1; i < allTypes.length; i++) {
			const t = allTypes[i]!;
			const name = lowerFirst(t.name);
			const ctx = {
				currentAliasName: t.name,
				paramsTopLevel: t.role === 'Params' || t.name.endsWith('Select') ? true : undefined
			} as const;
			lines.push(`and ${name} = ${printRsType(t.aliasOf, clientType, ir, ctx)}`);
		}
		lines.push('');
	}

	const mainFn = ir.functions.find((f) => f.name === ir.mainName) || ir.functions[0];
	if (mainFn) {
		const paramsTypes = mainFn.params.map((p) => printFnParamType(p.type, clientType, ir)).filter(Boolean) as string[];
		const paramsStr = paramsTypes.length > 0 ? `(${paramsTypes.join(', ')})` : 'unit';
		const returnType = printFnParamType(mainFn.returnType, clientType, ir) || 'unit';
		const signature = `${paramsStr} => ${returnType}`;

		const param = mainFn.params[1];
		const paramType = param?.type;

		lines.push(`external ${ir.mainName}: ${signature} = "${ir.mainName}"`);
		const paramArgStr = param != null ? ', params' : '';
		lines.push(`let run: ${signature} = (db${paramArgStr}) => {`);
		if (paramType?.kind === 'ref' && paramType.name.endsWith('DynamicParams')) {
			// Locate the DynamicParams alias and its 'where' element type
			const dynParams = ir.types.find((t) => t.name === paramType.name);
			const whereElemTypeName = (() => {
				if (!dynParams || dynParams.aliasOf.kind !== 'object') return undefined;
				const whereField = dynParams.aliasOf.fields.find((f) => f.name === 'where');
				if (!whereField) return undefined;
				const arr = ((): IRType | undefined => {
					const ty = whereField.type;
					if (ty.kind === 'array') return ty.of;
					if (ty.kind === 'union') {
						// optional may be represented as union with undefined
						const arrMem = ty.of.find((m) => m.kind === 'array') as Extract<IRType, { kind: 'array' }> | undefined;
						return arrMem?.of;
					}
					return undefined;
				})();
				if (arr && arr.kind === 'ref') return arr.name;
				return undefined;
			})();

			const whereAlias = whereElemTypeName ? ir.types.find((t) => t.name === whereElemTypeName) : undefined;
			const whereUnion = whereAlias && whereAlias.aliasOf.kind === 'union' ? whereAlias.aliasOf.of : undefined;
			const whereTuples = whereUnion?.filter((m) => m.kind === 'tuple') as Extract<IRType, { kind: 'tuple' }>[] | undefined;

			lines.push(`  let params = {`);
			lines.push(`    ...params,`);
			lines.push(`    where: ?switch params.where {`);
			lines.push(`    | Some(list) =>`);
			lines.push(`      Some(`);
			lines.push(`        list->Array.map(w =>`);
			lines.push(`          switch w {`);
			if (whereTuples && whereTuples.length > 0) {
				for (const tu of whereTuples) {
					const arm = renderTupleToMatchArm(tu);
					lines.push(`          | ${arm.pattern} => ${arm.toTuple}->Obj.magic`);
				}
			}
			lines.push(`          }`);
			lines.push(`        ),`);
			lines.push(`      )`);
			lines.push(`    | None => None`);
			lines.push(`    },`);
			lines.push(`  }`);
		}
		lines.push(`  ${ir.mainName}(db${paramArgStr})`);
		lines.push(`}`);
		lines.push('');
	}

	return lines.join('\n');
}

function renderTupleToMatchArm(t: Extract<IRType, { kind: 'tuple' }>): { pattern: string; toTuple: string } {
	const [col, _op, ...vals] = t.elements;
	const colName = col.kind === 'literal' && typeof col.value === 'string' ? col.value : 'unknown';
	// Match constructor naming produced by renderTupleAsVariantCtor
	const ctorName = (() => {
		const op = _op;
		let suffix = 'compare';
		if (op.kind === 'ref') {
			const name = op.name.toLowerCase();
			if (name.includes('between')) suffix = 'between';
			else if (name.includes('set')) suffix = 'list';
		}
		return `${toPascalCase(colName)}_${suffix}`;
	})();
	// Build pattern and tuple expr
	const argNames: string[] = ['op'];
	for (let i = 0; i < vals.length; i++) argNames.push(`v${i + 1}`);
	const pattern = `${ctorName}(${argNames.join(', ')})`;
	const tupleParts = [`"${colName}"`, ...argNames];
	return { pattern, toTuple: `(${tupleParts.join(', ')})` };
}

function printFnParamType(t: IRType | undefined, clientType: DatabaseClient['type'], ir: RescriptIR): string | undefined {
	if (!t) return undefined;
	return printRsType(t, clientType, ir);
}

type PrintCtx = {
	// When true, we're printing the top-level Params alias object.
	// Only the first encountered object should treat optional fields as `?:`.
	paramsTopLevel?: boolean;
	currentAliasName?: string;
};

function printRsType(t: IRType, clientType: DatabaseClient['type'], ir: RescriptIR, ctx?: PrintCtx): string {
	switch (t.kind) {
		case 'int':
			return 'int';
		case 'float':
			return 'float';
		case 'string':
			return 'string';
		case 'bool':
			return 'bool';
		case 'bigint':
			return 'BigInt.t';
		case 'date':
			return 'Date.t';
		case 'bytes':
			return clientType === 'better-sqlite3' || clientType === 'bun:sqlite' ? 'Uint8Array.t' : 'ArrayBuffer';
		case 'any':
			console.warn("Printing IR 'any' as ReScript 'unknown'");
			return 'unknown';
		case 'promise':
			return `promise<${printRsType(t.of, clientType, ir, ctx)}>`;
		case 'ref':
			if (t.name === 'Database') return mapDatabaseRef(clientType);
			if (t.name === 'JSON') return 'JSON.t';
			return lowerFirst(t.name);
		case 'literal': {
			if (typeof t.value === 'string') {
				// Print single string literal types as a polymorphic variant
				return `[#\"${escapeVariant(t.value)}\"]`;
			}
			if (typeof t.value === 'number') return 'float';
			if (typeof t.value === 'boolean') return 'bool';
			if (t.value === null) return 'Null.t<unknown>';
			console.warn(`Literal '${String(t.value)}' maps to ReScript 'unknown'`);
			return 'unknown';
		}
		case 'array':
			return `array<${printRsType(t.of, clientType, ir, ctx)}>`;
		case 'tuple': {
			const elems = t.elements.map((e) => printRsType(e, clientType, ir, ctx)).join(', ');
			return `(${elems})`;
		}
		case 'union': {
			const types = t.of;
			const hasNull = types.some(isNullLiteral);
			const hasUndefined = types.some(isUndefinedLiteral);
			const nonNil = types.filter((x) => !isNullLiteral(x) && !isUndefinedLiteral(x));

			// Helper to wrap inner with correct container depending on null/undefined presence
			const wrap = (inner: string): string => {
				if (hasNull && hasUndefined) return `Nullable.t<${inner}>`;
				if (hasUndefined) return `option<${inner}>`;
				if (hasNull) return `Null.t<${inner}>`;
				return inner;
			};

			// Polymorphic variant union of string literals
			const allStringLiterals = nonNil.length > 0 && nonNil.every((x) => x.kind === 'literal' && typeof x.value === 'string');
			if (allStringLiterals) {
				const body = nonNil
					.map((x) => `#\"${escapeVariant(x.kind === 'literal' && typeof x.value === 'string' ? x.value : '')}\"`)
					.join(' | ');
				const inner = `[${body}]`;
				return wrap(inner);
			}

			// Single non-nil type
			if (nonNil.length === 1) {
				const inner = printRsType(nonNil[0], clientType, ir, ctx);
				return wrap(inner);
			}

			// Dynamic where: union of tuple types -> ReScript variant
			const isAllTuples = nonNil.length > 0 && nonNil.every((x) => x.kind === 'tuple');
			if (isAllTuples && ctx?.currentAliasName && ctx.currentAliasName.endsWith('Where')) {
				const ctors = nonNil.map((tu) => renderTupleAsVariantCtor(tu as Extract<IRType, { kind: 'tuple' }>, clientType, ir));
				const unique = Array.from(new Set(ctors));
				return '\n' + '| ' + unique.join('\n| ');
			}

			// Special-case: Postgres client union (pg.Client | pg.Pool | pg.PoolClient)
			const isAllRefs = nonNil.length > 0 && nonNil.every((x) => x.kind === 'ref');
			if (clientType === 'pg' && isAllRefs) {
				const valid = new Set(['pg.Client', 'pg.Pool', 'pg.PoolClient']);
				const names = new Set(nonNil.map((x) => (x as Extract<IRType, { kind: 'ref' }>).name));
				const allValid = Array.from(names).every((n) => valid.has(n));
				if (allValid) {
					return wrap('Pg.client');
				}
			}

			// Unsupported TS-style multi-type unions: print as unknown with refined inline comment
			const renderedSet = new Set<string>();
			for (const part of nonNil) {
				const label = formatUnionMemberForComment(part, clientType, ir);
				renderedSet.add(label);
			}
			if (hasNull) renderedSet.add('null');
			if (hasUndefined) renderedSet.add('undefined');
			const rendered = Array.from(renderedSet).join(' | ');
			console.warn(`Unsupported TS-style union remains after transform -> printing as 'unknown /* ${rendered} */'.`);
			return `unknown /* ${rendered} */`;
		}
		case 'object': {
			// Only the top-level Params alias should render optional fields as `?:`.
			const inParamsTopLevel = ctx?.paramsTopLevel === true;
			const fields = t.fields
				.map((f) => {
					if (inParamsTopLevel && f.optional) {
						const ty = printRsType(f.type, clientType, ir, { ...ctx, paramsTopLevel: false });
						return `${lowerFirst(f.name)}?: ${ty}`;
					}
					// For non-Params or non-optional: if optional, interpret as `| undefined` and rely on union logic
					const effectiveType = f.optional ? addUndefinedToIR(f.type) : f.type;
					const ty = printRsType(effectiveType, clientType, ir, { ...ctx, paramsTopLevel: false });
					return `${lowerFirst(f.name)}: ${ty}`;
				})
				.join(',\n  ');
			return `{\n  ${fields}\n}`;
		}
	}
}

function renderTupleAsVariantCtor(t: Extract<IRType, { kind: 'tuple' }>, clientType: DatabaseClient['type'], ir: RescriptIR): string {
	// Expect [literal string column, operator ref, value, value?]
	const [col, op, ...vals] = t.elements;
	const colName = col.kind === 'literal' && typeof col.value === 'string' ? col.value : 'Unknown';
	const pascalCol = toPascalCase(colName);
	let suffix = 'compare';
	let opTy = 'unknown';
	if (op.kind === 'ref') {
		const opName = op.name;
		const lower = lowerFirst(opName);
		opTy = lower;
		if (opName.toLowerCase().includes('between')) suffix = 'between';
		else if (opName.toLowerCase().includes('set')) suffix = 'list';
		else if (opName.toLowerCase().includes('numeric')) suffix = 'compare';
		else if (opName.toLowerCase().includes('string')) suffix = 'compare';
	}
	const payloadTypes = [opTy, ...vals.map((v) => printRsType(v, clientType, ir))];
	return `${pascalCol}_${suffix}(${payloadTypes.join(', ')})`;
}

function isNullLiteral(t: IRType): boolean {
	return t.kind === 'literal' && t.value === null;
}

function isUndefinedLiteral(t: IRType): boolean {
	return t.kind === 'literal' && typeof t.value === 'undefined';
}

function addUndefinedToIR(t: IRType): IRType {
	if (isUndefinedLiteral(t)) return t;
	if (t.kind === 'union') {
		const hasUndef = t.of.some(isUndefinedLiteral);
		if (hasUndef) return t;
		return { kind: 'union', of: [...t.of, { kind: 'literal', value: undefined }] };
	}
	return { kind: 'union', of: [t, { kind: 'literal', value: undefined }] };
}

function mapDatabaseRef(clientType: DatabaseClient['type']): string {
	switch (clientType) {
		case 'better-sqlite3':
			return 'BetterSqlite3.client';
		case 'bun:sqlite':
			return 'BunSqlite.client';
		case 'libsql':
			return 'Libsql.client';
		case 'd1':
			return 'D1.client';
		case 'pg':
			return 'Pg.client';
		case 'mysql2':
			return 'Mysql2.client';
	}
}

function lowerFirst(name: string): string {
	if (!name) return name;
	return name[0]!.toLowerCase() + name.slice(1);
}

function escapeVariant(v: string): string {
	return v.replace(/\"/g, '\\\"');
}

function formatUnionMemberForComment(t: IRType, clientType: DatabaseClient['type'], ir: RescriptIR): string {
	switch (t.kind) {
		case 'int':
		case 'float':
		case 'string':
		case 'bool':
			return t.kind;
		case 'bigint':
			return 'BigInt';
		case 'date':
			return 'Date';
		case 'bytes':
			return clientType === 'better-sqlite3' || clientType === 'bun:sqlite' ? 'Uint8Array' : 'ArrayBuffer';
		case 'any':
			return 'any';
		case 'promise':
			return `promise<${formatUnionMemberForComment(t.of, clientType, ir)}>`;
		case 'ref': {
			if (t.name === 'Database') return 'Database';
			return lowerFirst(t.name);
		}
		case 'literal': {
			const v = t.value;
			if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
			if (typeof v === 'number') return String(v);
			if (typeof v === 'boolean') return String(v);
			if (v === null) return 'null';
			if (typeof v === 'undefined') return 'undefined';
			return 'unknown';
		}
		case 'array':
			return `array<${formatUnionMemberForComment(t.of, clientType, ir)}>`;
		case 'union': {
			// Flatten nested unions for comments
			const parts = new Set<string>();
			for (const p of t.of) {
				const label = formatUnionMemberForComment(p, clientType, ir);
				parts.add(label);
			}
			return Array.from(parts).join(' | ');
		}
		case 'object':
			return 'object';
		case 'tuple':
			return 'tuple';
	}
}
