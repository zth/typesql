import type { SchemaInfo, PostgresSchemaInfo } from './schema-info';
import { generateTypeScriptContent } from './code-generator';
import type { DatabaseClient, SQLiteClient } from './types';
import { SQLiteType } from './sqlite-query-analyzer/types';
import { TsType } from './mysql-mapping';
import { mapper as mapperSqlite } from './drivers/sqlite';
import ts from 'typescript';

// Lightweight logging so callers can see lossy mappings.
// We log whenever a TS construct maps to IR 'any' or prints as ReScript 'unknown',
// and when a TS-style union remains after our transforms.
function logWarn(message: string) {
	try {
		// Prefer warn to avoid breaking stdout-based comparisons
		console.warn(`[rescript-gen] ${message}`);
	} catch {
		// noop in environments without console
	}
}

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
	logWarn(`SQLite type '${sqliteType}' not explicitly mapped -> defaulting to 'any'`);
	return 'any';
};

function setupMappers() {
	mapperSqlite.mapColumnType = (sqliteType, client) => mapSqlite(sqliteType, client) as TsType;
}

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

	const ir = extractRescriptIRFromTypeScript(generated.right, queryName);
	const rescript = printRescript(ir, databaseClient.type);
	return { rescript, originalTs: generated.right };
}

export async function generateReScriptCodeFromSql(params: GenerateSqlApiParams): Promise<string> {
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

	const ir = extractRescriptIRFromTypeScript(generated.right, queryName);
	return printRescript(ir, databaseClient.type);
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
	queryName: string; // e.g. selectUsers
	pascalName: string; // e.g. SelectUsers
	types: IRTypeDef[]; // Extracted types we care about
	functions: IRFunction[]; // Functions with signatures and optional JS bodies
};

// Public entry: parse TS string and extract a minimal IR for ReScript printing
export function extractRescriptIRFromTypeScript(tsCode: string, queryName: string): RescriptIR {
	const source = ts.createSourceFile('generated.ts', tsCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const pascalName = toPascalCase(queryName);
	const wanted = new Set([`${pascalName}Params`, `${pascalName}Result`]);

	const types: IRTypeDef[] = [];
	const functions: IRFunction[] = [];

	for (const stmt of source.statements) {
		if (ts.isTypeAliasDeclaration(stmt)) {
			const name = stmt.name.text;
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
		const fn = extractFunctionFromStatement(stmt, source);
		if (fn) functions.push(...(Array.isArray(fn) ? fn : [fn]));
	}

	return { queryName, pascalName, types, functions };
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
		const typeName = node.typeName.getText();
		if (typeName === 'Date') return { kind: 'date' };
		if (typeName === 'Uint8Array' || typeName === 'ArrayBuffer') return { kind: 'bytes' };
		// Normalize scalar aliases our mapper might emit
		if (typeName === 'int') return { kind: 'int' };
		if (typeName === 'float') return { kind: 'float' };
		if (typeName === 'bool') return { kind: 'bool' };
		if (typeName === 'string') return { kind: 'string' };
		if (typeName === 'any' || typeName === 'unknown') {
			logWarn(`Encountered type reference '${typeName}' -> mapping to IR 'any' (${node.getText()})`);
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
		if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null } as any;
	}
	if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: 'float' };
	if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: 'bool' };
	if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: 'string' };
	if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null } as any;
	if (node.kind === ts.SyntaxKind.UndefinedKeyword) return { kind: 'literal', value: undefined } as any;
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
	isExported: boolean;
	params: IRFunctionParam[];
	returnType?: IRType;
	jsBody?: string; // If successfully stripped of types
};

function extractFunctionFromStatement(stmt: ts.Statement, source: ts.SourceFile): IRFunction | IRFunction[] | undefined {
	if (ts.isFunctionDeclaration(stmt) && stmt.name) {
		const name = stmt.name.text;
		const isExported = hasExportModifier(stmt.modifiers);
		const params = (stmt.parameters || []).map(paramToIRParam);
		const returnType = stmt.type ? typeNodeToIRRef(stmt.type) : undefined;
		const jsBody = sanitizeJsBody(tryTranspileToJs(stmt.getText(source)));
		return { name, isExported, params, returnType, jsBody };
	}
	if (ts.isVariableStatement(stmt)) {
		const isExported = hasExportModifier(stmt.modifiers);
		const out: IRFunction[] = [];
		for (const decl of stmt.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name)) continue;
			const name = decl.name.text;
			const init = decl.initializer;
			if (init && (ts.isFunctionExpression(init) || ts.isArrowFunction(init))) {
				const params = (init.parameters || []).map(paramToIRParam);
				const returnType = init.type ? typeNodeToIRRef(init.type) : undefined;
				const jsBody = sanitizeJsBody(tryTranspileToJs(stmt.getText(source)));
				out.push({ name, isExported, params, returnType, jsBody });
			}
		}
		if (out.length > 0) return out;
	}
	return undefined;
}

function hasExportModifier(mods: ts.NodeArray<ts.ModifierLike> | undefined): boolean {
	return (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
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
		const typeName = node.typeName.getText();
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

// Transpile a TS snippet (e.g., a single function declaration) to JS with types erased
function tryTranspileToJs(tsSnippet: string): string | undefined {
	try {
		const out = ts.transpileModule(tsSnippet, {
			compilerOptions: {
				target: ts.ScriptTarget.ES2019,
				module: ts.ModuleKind.ESNext,
				removeComments: false
			}
		});
		return out.outputText.trim();
	} catch {
		return undefined;
	}
}

function sanitizeJsBody(jsBody: string | undefined): string | undefined {
	if (!jsBody) return jsBody;
	// Remove a single leading 'export' or 'export default' but preserve formatting
	const code = jsBody.replace(/^\s*export\s+(?:default\s+)?/, '');
	return code;
}

function statementToExpression(jsStatement: string): string {
	const code = jsStatement;
	if (/^\s*function\s+\w+\s*\(/.test(code)) {
		// Turn declaration into function expression, preserve formatting
		return '(' + code + ')';
	}
	const varMatch = /^\s*(?:const|let|var)\s+\w+\s*=\s*([\s\S]+?);?\s*$/.exec(code);
	if (varMatch) {
		const rhs = varMatch[1];
		return rhs;
	}
	return code;
}

function encodeRawString(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
}

// ReScript printer and helpers
export function printRescript(ir: RescriptIR, clientType: DatabaseClient['type']): string {
	const lines: string[] = [];

	// Order type aliases so that dependencies appear before use
	const orderedTypes = orderTypesTopologically(ir.types);
	for (const t of orderedTypes) {
		// Print Params/Result with canonical names, all other aliases as camelCase of original
		if (t.role === 'Params') {
			const ctx = { paramsTopLevel: true } as const;
			lines.push(`type params = ${printRsType(t.aliasOf, clientType, ir, ctx)}`);
			lines.push('');
			continue;
		}
		if (t.role === 'Result') {
			lines.push(`type result = ${printRsType(t.aliasOf, clientType, ir)}`);
			lines.push('');
			continue;
		}
		const otherName = lowerFirst(t.name);
		lines.push(`type ${otherName} = ${printRsType(t.aliasOf, clientType, ir)}`);
		lines.push('');
	}

	// Emit helper functions first, then main query function last
	const helperFns = ir.functions.filter((f) => f.name !== ir.queryName);
	const mainFns = ir.functions.filter((f) => f.name === ir.queryName);
	for (const fn of [...helperFns, ...mainFns]) {
		const isMain = fn.name === ir.queryName;
		const jsStmt = fn.jsBody || '';
		if (isMain) {
			const paramsTypes = fn.params.map((p) => printFnParamType(p.type, clientType, ir)).filter(Boolean) as string[];
			const paramsStr = paramsTypes.length > 0 ? `(${paramsTypes.join(', ')})` : 'unit';
			const returnType = printFnParamType(fn.returnType, clientType, ir) || 'unit';
			const signature = `${paramsStr} => ${returnType}`;
			const expr = statementToExpression(jsStmt);
			const js = encodeRawString(expr);
			lines.push(`let run: ${signature} = %raw("${js}")`);
			lines.push('');
		} else {
			const js = encodeRawString(jsStmt);
			lines.push(`%%raw("${js}")`);
			lines.push('');
		}
	}

	return lines.join('\n');
}

function orderRole(role: IRTypeDef['role']): number {
	if (role === 'Params') return 0;
	if (role === 'Result') return 1;
	return 2;
}

function orderTypesTopologically(types: IRTypeDef[]): IRTypeDef[] {
	const byName = new Map(types.map((t) => [t.name, t] as const));
	const deps = new Map<string, Set<string>>();

	const collect = (t: IRType): Set<string> => {
		const out = new Set<string>();
		const visit = (node: IRType) => {
			switch (node.kind) {
				case 'array':
					visit(node.of);
					break;
				case 'union':
					node.of.forEach(visit);
					break;
				case 'object':
					node.fields.forEach((f) => visit(f.type));
					break;
				case 'ref':
					if (byName.has(node.name)) out.add(node.name);
					break;
			}
		};
		visit(t);
		return out;
	};

	for (const t of types) {
		deps.set(t.name, collect(t.aliasOf));
	}

	// Kahn's algorithm with role-based tiebreaker and stable order
	const incomingCount = new Map<string, number>();
	for (const [name, _set] of deps) incomingCount.set(name, 0);
	for (const [_name, set] of deps) {
		for (const d of set) {
			incomingCount.set(d, (incomingCount.get(d) || 0) + 1);
		}
	}

	const result: IRTypeDef[] = [];
	const queue: IRTypeDef[] = types.filter((t) => (incomingCount.get(t.name) || 0) === 0);
	// Stable sort by role priority to keep params/result early when possible
	queue.sort((a, b) => orderRole(a.role) - orderRole(b.role));

	const enqueued = new Set(queue.map((t) => t.name));

	while (queue.length > 0) {
		const n = queue.shift()!;
		result.push(n);
		for (const [m, set] of deps) {
			if (set.has(n.name)) {
				set.delete(n.name);
				incomingCount.set(m, (incomingCount.get(m) || 1) - 1);
				if ((incomingCount.get(m) || 0) === 0 && !enqueued.has(m)) {
					const def = byName.get(m)!;
					enqueued.add(m);
					// keep stable + role priority
					let i = 0;
					for (; i < queue.length; i++) {
						if (orderRole(def.role) < orderRole(queue[i]!.role)) break;
					}
					queue.splice(i, 0, def);
				}
			}
		}
	}

	// If cycle or leftover due to unknown refs, append remaining in original order
	if (result.length !== types.length) {
		const seen = new Set(result.map((t) => t.name));
		for (const t of types) if (!seen.has(t.name)) result.push(t);
	}

	return result;
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
			logWarn("Printing IR 'any' as ReScript 'unknown'");
			return 'unknown';
		case 'ref':
			if (t.name === 'Database') return mapDatabaseRef(clientType);
			if (t.name === `${ir.pascalName}Params`) return 'params';
			if (t.name === `${ir.pascalName}Result`) return 'result';
			return lowerFirst(t.name);
		case 'literal': {
			if (typeof t.value === 'string') return 'string';
			if (typeof t.value === 'number') return 'float';
			if (typeof t.value === 'boolean') return 'bool';
			logWarn(`Literal '${String(t.value)}' maps to ReScript 'unknown'`);
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
			const renderedParts: string[] = [];
			for (const part of nonNil) {
				const label = formatUnionMemberForComment(part, clientType, ir);
				if (!renderedParts.includes(label)) renderedParts.push(label);
			}
			if (hasNull && !renderedParts.includes('null')) renderedParts.push('null');
			if (hasUndefined && !renderedParts.includes('undefined')) renderedParts.push('undefined');
			const rendered = renderedParts.join(' | ');
			logWarn(`Unsupported TS-style union remains after transform -> printing as 'unknown /* ${rendered} */'.`);
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
	return t.kind === 'literal' && (t as any).value === null;
}

function isUndefinedLiteral(t: IRType): boolean {
	return t.kind === 'literal' && typeof (t as any).value === 'undefined';
}

function addUndefinedToIR(t: IRType): IRType {
	if (isUndefinedLiteral(t)) return t;
	if (t.kind === 'union') {
		const hasUndef = t.of.some(isUndefinedLiteral);
		if (hasUndef) return t;
		return { kind: 'union', of: [...t.of, { kind: 'literal', value: undefined } as any] };
	}
	return { kind: 'union', of: [t, { kind: 'literal', value: undefined } as any] };
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
			if (t.name === `${ir.pascalName}Params`) return 'params';
			if (t.name === `${ir.pascalName}Result`) return 'result';
			return lowerFirst(t.name);
		}
		case 'literal': {
			const v = (t as any).value;
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
			const parts: string[] = [];
			for (const p of t.of) {
				const label = formatUnionMemberForComment(p, clientType, ir);
				if (!parts.includes(label)) parts.push(label);
			}
			return parts.join(' | ');
		}
		case 'object':
			return 'object';
	}
}
