import type { SchemaInfo, PostgresSchemaInfo } from './schema-info';
import { generateTypeScriptContent } from './code-generator';
import type { DatabaseClient, SQLiteClient } from './types';
import { SQLiteType } from './sqlite-query-analyzer/types';
import { TsType } from './mysql-mapping';
import { mapper as mapperSqlite } from './drivers/sqlite';
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
}

// Type aliases we should not emit into ReScript output
const TYPE_ALIAS_IGNORE = new Set<string>(['WhereConditionResult']);

export type GenerateSqlApiParams = {
	sql: string;
	queryName?: string;
	isCrudFile?: boolean;
	databaseClient: DatabaseClient;
	schemaInfo: SchemaInfo | PostgresSchemaInfo;
};

export async function generateReScriptFromSql(params: GenerateSqlApiParams): Promise<{ rescript: string; originalTs: string }> {
	// Ensure TS generator maps SQLite types to ReScript-friendly names (int, float, bool)
	setupMappers();
	const { databaseClient, schemaInfo } = params;
	const queryName = params.queryName ?? 'query';
	const isCrudFile = params.isCrudFile ?? false;

	const generated = await generateTypeScriptContent({
		client: databaseClient,
		queryName,
		sqlContent: params.sql,
		schemaInfo,
		isCrudFile
	});

	if (generated._tag === 'Left') {
		throw new Error(generated.left.description);
	}

	// Remove all `export ` keywords from the generated TS before further processing
	const tsWithoutExports = generated.right.replace(/\bexport\s+/g, '');
	const ir = extractRescriptIRFromTypeScript(tsWithoutExports, queryName);
	const blankedJs = tsBlankSpace(tsWithoutExports);
	const formattedJs = dprint.format('generated.js', blankedJs, {
		lineWidth: 100,
		semiColons: 'asi',
		quoteStyle: 'alwaysSingle'
	});
	const rescript = printRescript(ir, databaseClient.type, { rawJs: formattedJs });
	// Keep original TS for callers; expansion is only for internal processing
	return { rescript, originalTs: generated.right };
}

export type IRType =
	| { kind: 'int' | 'float' | 'string' | 'bool' | 'date' | 'bytes' | 'any' }
	| { kind: 'array'; of: IRType }
	| { kind: 'union'; of: IRType[] }
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
	const source = ts.createSourceFile('generated.ts', tsCode, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const pascalName = toPascalCase(queryName);

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
			const aliasOf = typeNodeToIR(stmt.type);
			types.push({ name, role, aliasOf });
		}
		// Collect const-based functions
		const fn = extractFunctionFromStatement(stmt, source);
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

function typeNodeToIR(node: ts.TypeNode): IRType {
	if (ts.isTypeLiteralNode(node)) {
		const fields: IRField[] = node.members.filter(ts.isPropertySignature).map((m) => {
			const name = getPropertyName(m.name);
			const optional = m.questionToken != null;
			const typeNode = m.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
			return { name, optional, type: typeNodeToIR(typeNode) };
		});
		return { kind: 'object', fields };
	}
	if (ts.isArrayTypeNode(node)) {
		return { kind: 'array', of: typeNodeToIR(node.elementType) };
	}
	if (ts.isUnionTypeNode(node)) {
		return { kind: 'union', of: node.types.map(typeNodeToIR) };
	}
	if (ts.isTypeReferenceNode(node)) {
		const typeName = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.getText();
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
			return { kind: 'array', of: typeNodeToIR(node.typeArguments[0]!) };
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

function extractFunctionFromStatement(stmt: ts.Statement, source: ts.SourceFile): IRFunction | IRFunction[] | undefined {
	if (ts.isFunctionDeclaration(stmt) && stmt.name) {
		const name = stmt.name.text;
		const params = (stmt.parameters || []).map(paramToIRParam);
		const returnType = stmt.type ? typeNodeToIRRef(stmt.type) : undefined;
		return { name, params, returnType };
	}
	if (ts.isVariableStatement(stmt)) {
		const out: IRFunction[] = [];
		for (const decl of stmt.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name)) continue;
			const name = decl.name.text;
			const init = decl.initializer;
			if (init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))) {
				const params = (init.parameters || []).map(paramToIRParam);
				const returnType = init.type ? typeNodeToIRRef(init.type) : undefined;
				out.push({ name, params, returnType });
			}
		}
		if (out.length > 0) return out;
	}
	return undefined;
}

function paramToIRParam(p: ts.ParameterDeclaration): IRFunctionParam {
	const name = getPropertyName(p.name);
	const optional = p.questionToken != null;
	const type = p.type ? typeNodeToIRRef(p.type) : undefined;
	return { name, optional, type };
}

// Similar to typeNodeToIR, but preserves references as refs instead of defaulting to 'any'
function typeNodeToIRRef(node: ts.TypeNode): IRType {
	if (ts.isTypeReferenceNode(node)) {
		const typeName = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.getText();
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
			return { kind: 'array', of: typeNodeToIR(node.typeArguments[0]!) };
		}

		return { kind: 'ref', name: typeName };
	}
	return typeNodeToIR(node);
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
		const firstCtx = first.role === 'Params' ? ({ paramsTopLevel: true } as const) : undefined;
		lines.push(`type rec ${firstName} = ${printRsType(first.aliasOf, clientType, ir, firstCtx)}`);
		for (let i = 1; i < allTypes.length; i++) {
			const t = allTypes[i]!;
			const name = lowerFirst(t.name);
			const ctx = t.role === 'Params' ? ({ paramsTopLevel: true } as const) : undefined;
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
		lines.push(`external ${ir.mainName}: ${signature} = "${ir.mainName}"`);
		lines.push(`let run = ${ir.mainName}`);
		lines.push('');
	}

	return lines.join('\n');
}

function printFnParamType(t: IRType | undefined, clientType: DatabaseClient['type'], ir: RescriptIR): string | undefined {
	if (!t) return undefined;
	return printRsType(t, clientType, ir);
}

type PrintCtx = {
	// When true, we're printing the top-level Params alias object.
	// Only the first encountered object should treat optional fields as `?:`.
	paramsTopLevel?: boolean;
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
		case 'date':
			return 'Date.t';
		case 'bytes':
			return clientType === 'better-sqlite3' || clientType === 'bun:sqlite' ? 'Uint8Array.t' : 'ArrayBuffer';
		case 'any':
			console.warn("Printing IR 'any' as ReScript 'unknown'");
			return 'unknown';
		case 'ref':
			if (t.name === 'Database') return mapDatabaseRef(clientType);
			return lowerFirst(t.name);
		case 'literal': {
			if (typeof t.value === 'string') {
				// Print single string literal types as a polymorphic variant
				return `[#\"${escapeVariant(t.value)}\"]`;
			}
			if (typeof t.value === 'number') return 'float';
			if (typeof t.value === 'boolean') return 'bool';
			console.warn(`Literal '${String(t.value)}' maps to ReScript 'unknown'`);
			return 'unknown';
		}
		case 'array':
			return `array<${printRsType(t.of, clientType, ir)}>`;
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
						const ty = printRsType(f.type, clientType, ir, { paramsTopLevel: false });
						return `${lowerFirst(f.name)}?: ${ty}`;
					}
					// For non-Params or non-optional: if optional, interpret as `| undefined` and rely on union logic
					const effectiveType = f.optional ? addUndefinedToIR(f.type) : f.type;
					const ty = printRsType(effectiveType, clientType, ir, { paramsTopLevel: false });
					return `${lowerFirst(f.name)}: ${ty}`;
				})
				.join(',\n\t');
			return `{\n\t${fields}\n}`;
		}
	}
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
		case 'date':
			return 'Date';
		case 'bytes':
			return clientType === 'better-sqlite3' || clientType === 'bun:sqlite' ? 'Uint8Array' : 'ArrayBuffer';
		case 'any':
			return 'any';
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
	}
}
