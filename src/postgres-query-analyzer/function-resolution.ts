import { PostgresBuiltinFunctionSchema } from './builtin-functions';
import { UserFunctionSchema } from './types';

export type ResolvedTableColumn = {
	name: string;
	type: string;
};

export type ResolvedFunctionReturn =
	| {
		kind: 'table';
		columns: ResolvedTableColumn[];
		returnsSet: true;
	}
	| {
		kind: 'record';
		returnsSet: boolean;
	}
	| {
		kind: 'named';
		typeName: string;
		returnsSet: boolean;
	};

export type ResolvedFunctionMetadata = {
	origin: 'user' | 'builtin';
	schema: string;
	functionName: string;
	identityArguments: string;
	returnTypeText: string;
	returnType: ResolvedFunctionReturn;
	language: string;
	definition?: string;
};

export type FunctionResolution =
	| { status: 'resolved'; value: ResolvedFunctionMetadata }
	| { status: 'ambiguous'; candidates: ResolvedFunctionMetadata[] }
	| { status: 'unresolved' };

type ResolveFunctionName = {
	schema?: string;
	name: string;
};

export function resolvePostgresFunction(functionName: ResolveFunctionName, userFunctions: UserFunctionSchema[], builtinFunctions: PostgresBuiltinFunctionSchema[], actualArgumentTypes: string[] = []): FunctionResolution {
	const userMatches = findMatchingUserFunctions(functionName, userFunctions);
	const userResolution = resolveCandidates(userMatches, actualArgumentTypes);
	if (userResolution) {
		return userResolution;
	}

	const builtinMatches = findMatchingBuiltinFunctions(functionName, builtinFunctions);
	const builtinResolution = resolveCandidates(builtinMatches, actualArgumentTypes);
	if (builtinResolution) {
		return builtinResolution;
	}

	return { status: 'unresolved' };
}

export function findPostgresFunctionCandidates(functionName: ResolveFunctionName, userFunctions: UserFunctionSchema[], builtinFunctions: PostgresBuiltinFunctionSchema[]): ResolvedFunctionMetadata[] {
	const userMatches = findMatchingUserFunctions(functionName, userFunctions);
	if (userMatches.length > 0) {
		return userMatches;
	}
	return findMatchingBuiltinFunctions(functionName, builtinFunctions);
}

export function normalizeUserFunction(functionInfo: UserFunctionSchema): ResolvedFunctionMetadata {
	return {
		origin: 'user',
		schema: functionInfo.schema,
		functionName: functionInfo.function_name,
		identityArguments: functionInfo.arguments,
		returnTypeText: functionInfo.return_type,
		returnType: parseFunctionReturnType(functionInfo.return_type, inferReturnsSet(functionInfo.return_type)),
		language: functionInfo.language,
		definition: functionInfo.definition
	};
}

export function normalizeBuiltinFunction(functionInfo: PostgresBuiltinFunctionSchema): ResolvedFunctionMetadata {
	return {
		origin: 'builtin',
		schema: functionInfo.schema,
		functionName: functionInfo.function_name,
		identityArguments: functionInfo.identity_arguments,
		returnTypeText: functionInfo.return_type,
		returnType: parseFunctionReturnType(functionInfo.return_type, functionInfo.returns_set),
		language: functionInfo.language
	};
}

export function parseFunctionReturnType(returnTypeText: string, returnsSet: boolean): ResolvedFunctionReturn {
	const trimmed = returnTypeText.trim();

	if (trimmed.toLowerCase().startsWith('table(') && trimmed.endsWith(')')) {
		const inside = trimmed.slice(6, -1);
		return {
			kind: 'table',
			columns: splitTopLevelCommaList(inside).map(parseTableColumnDefinition),
			returnsSet: true
		};
	}

	const setofMatch = trimmed.match(/^SETOF\s+(.+)$/i);
	if (setofMatch) {
		const typeName = setofMatch[1].trim();
		if (typeName.toLowerCase() === 'record') {
			return { kind: 'record', returnsSet: true };
		}
		return {
			kind: 'named',
			typeName,
			returnsSet: true
		};
	}

	if (trimmed.toLowerCase() === 'record') {
		return { kind: 'record', returnsSet };
	}

	return {
		kind: 'named',
		typeName: trimmed,
		returnsSet
	};
}

function findMatchingUserFunctions(functionName: ResolveFunctionName, userFunctions: UserFunctionSchema[]) {
	const normalizedName = functionName.name.toLowerCase();
	const normalizedSchema = functionName.schema?.toLowerCase();
	return userFunctions
		.filter((fn) => fn.function_name.toLowerCase() === normalizedName)
		.filter((fn) => normalizedSchema == null || fn.schema.toLowerCase() === normalizedSchema)
		.map(normalizeUserFunction);
}

function findMatchingBuiltinFunctions(functionName: ResolveFunctionName, builtinFunctions: PostgresBuiltinFunctionSchema[]) {
	const normalizedName = functionName.name.toLowerCase();
	const normalizedSchema = functionName.schema?.toLowerCase();
	return builtinFunctions
		.filter((fn) => fn.function_name.toLowerCase() === normalizedName)
		.filter((fn) => normalizedSchema == null || fn.schema.toLowerCase() === normalizedSchema)
		.map(normalizeBuiltinFunction);
}

function inferReturnsSet(returnTypeText: string) {
	return /^SETOF\s+/i.test(returnTypeText.trim()) || /^TABLE\s*\(/i.test(returnTypeText.trim());
}

function resolveCandidates(candidates: ResolvedFunctionMetadata[], actualArgumentTypes: string[]): FunctionResolution | null {
	if (candidates.length === 0) {
		return null;
	}

	const rankedCandidates = rankCandidatesByArguments(candidates, actualArgumentTypes);
	if (rankedCandidates.length === 1) {
		return { status: 'resolved', value: rankedCandidates[0] };
	}
	if (rankedCandidates.length > 1) {
		return { status: 'ambiguous', candidates: rankedCandidates };
	}

	if (candidates.length === 1) {
		return { status: 'resolved', value: candidates[0] };
	}
	return { status: 'ambiguous', candidates };
}

function rankCandidatesByArguments(candidates: ResolvedFunctionMetadata[], actualArgumentTypes: string[]): ResolvedFunctionMetadata[] {
	if (actualArgumentTypes.length === 0) {
		return [];
	}

	const ranked = candidates
		.map(candidate => ({
			candidate,
			score: scoreCandidate(candidate, actualArgumentTypes)
		}))
		.filter(candidate => candidate.score > NO_MATCH_SCORE)
		.sort((left, right) => right.score - left.score);

	if (ranked.length === 0) {
		return [];
	}

	const bestScore = ranked[0].score;
	return ranked
		.filter(candidate => candidate.score === bestScore)
		.map(candidate => candidate.candidate);
}

const NO_MATCH_SCORE = -1;
const UNKNOWN_MATCH_SCORE = 1;
const NUMERIC_FAMILY_SCORE = 25;
const TEMPORAL_FAMILY_SCORE = 18;
const STRING_FAMILY_SCORE = 15;
const ARRAY_FAMILY_SCORE = 70;
const ELEMENT_FAMILY_SCORE = 60;
const EXACT_MATCH_SCORE = 100;

function scoreCandidate(candidate: ResolvedFunctionMetadata, actualArgumentTypes: string[]) {
	const declaredArgumentTypes = parseArgumentTypes(candidate.identityArguments);
	if (declaredArgumentTypes.length !== actualArgumentTypes.length) {
		return NO_MATCH_SCORE;
	}

	let score = 0;
	for (let index = 0; index < declaredArgumentTypes.length; index++) {
		const compatibilityScore = scoreArgumentCompatibility(actualArgumentTypes[index], declaredArgumentTypes[index]);
		if (compatibilityScore === NO_MATCH_SCORE) {
			return NO_MATCH_SCORE;
		}
		score += compatibilityScore;
	}
	return score;
}

function parseArgumentTypes(argumentList: string): string[] {
	return splitTopLevelCommaList(argumentList).map(parseArgumentType);
}

function parseArgumentType(argument: string): string {
	const withoutMode = argument.trim().replace(/^(variadic|inout|in|out)\s+/i, '');
	if (looksLikeTypeName(withoutMode)) {
		return normalizeLooseTypeName(withoutMode);
	}
	const withoutParameterName = withoutMode.replace(/^("[^"]+"|[a-zA-Z_][a-zA-Z0-9_$]*)\s+/, '');
	return normalizeLooseTypeName(withoutParameterName);
}

function scoreArgumentCompatibility(actualArgumentType: string, declaredArgumentType: string): number {
	const actual = normalizeLooseTypeName(actualArgumentType);
	const declared = normalizeLooseTypeName(declaredArgumentType);

	if (actual === declared) {
		return EXACT_MATCH_SCORE;
	}
	if (sameCompositeType(actual, declared)) {
		return EXACT_MATCH_SCORE - 2;
	}
	if (actual === 'unknown') {
		return UNKNOWN_MATCH_SCORE;
	}
	if (actual === 'record' && isNamedCompositeType(declared)) {
		return ELEMENT_FAMILY_SCORE - 10;
	}
	if (declared === 'record' && isNamedCompositeType(actual)) {
		return ELEMENT_FAMILY_SCORE - 10;
	}
	if (declared === 'anyarray' || declared === 'anycompatiblearray') {
		return isArrayType(actual) ? ARRAY_FAMILY_SCORE : NO_MATCH_SCORE;
	}
	if (declared === 'anyelement' || declared === 'anycompatible' || declared === 'anynonarray' || declared === 'anyenum') {
		return !isArrayType(actual) ? ELEMENT_FAMILY_SCORE : NO_MATCH_SCORE;
	}
	if (isArrayType(actual) && isArrayType(declared)) {
		const elementCompatibility = scoreArgumentCompatibility(getArrayElementType(actual), getArrayElementType(declared));
		return elementCompatibility === NO_MATCH_SCORE ? NO_MATCH_SCORE : elementCompatibility - 5;
	}
	if (sameTypeFamily(actual, declared, numericTypeFamily)) {
		return NUMERIC_FAMILY_SCORE;
	}
	if (sameTypeFamily(actual, declared, temporalTypeFamily)) {
		return TEMPORAL_FAMILY_SCORE;
	}
	if (sameTypeFamily(actual, declared, stringTypeFamily)) {
		return STRING_FAMILY_SCORE;
	}

	return NO_MATCH_SCORE;
}

const numericTypeFamily = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8']);
const temporalTypeFamily = new Set(['date', 'timestamp', 'timestamptz', 'time', 'timetz', 'interval']);
const stringTypeFamily = new Set(['text', 'varchar', 'bpchar', 'name', 'cstring']);

function sameTypeFamily(actual: string, declared: string, family: Set<string>) {
	return family.has(actual) && family.has(declared);
}

function isArrayType(typeName: string) {
	return typeName.endsWith('[]') || typeName.startsWith('_') || typeName === 'anyarray' || typeName === 'anycompatiblearray';
}

function getArrayElementType(typeName: string) {
	if (typeName.endsWith('[]')) {
		return typeName.slice(0, -2);
	}
	if (typeName.startsWith('_')) {
		return typeName.slice(1);
	}
	return typeName;
}

function normalizeLooseTypeName(typeName: string) {
	return normalizePostgresTypeName(typeName) || typeName.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizePostgresTypeName(typeName: string): string | null {
	const trimmed = typeName.trim();
	if (trimmed === '') {
		return null;
	}

	let normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
	normalized = normalized.replace(/\s*\[\s*\]/g, '[]');
	normalized = normalized.replace(/\(\s*[^()]*\s*\)/g, '').trim();

	if (normalized.endsWith('[]')) {
		const innerType = normalizePostgresTypeName(normalized.slice(0, -2));
		return innerType ? `${innerType}[]` : normalized;
	}

	switch (normalized) {
		case 'smallint':
			return 'int2';
		case 'integer':
		case 'int':
			return 'int4';
		case 'bigint':
			return 'int8';
		case 'real':
			return 'float4';
		case 'double precision':
		case 'double':
			return 'float8';
		case 'boolean':
			return 'bool';
		case 'character varying':
		case 'varchar':
			return 'varchar';
		case 'character':
		case 'char':
			return 'bpchar';
		case 'timestamp without time zone':
		case 'timestamp':
			return 'timestamp';
		case 'timestamp with time zone':
			return 'timestamptz';
		case 'time without time zone':
		case 'time':
			return 'time';
		case 'time with time zone':
			return 'timetz';
		case 'decimal':
			return 'numeric';
		case 'bit varying':
			return 'varbit';
		default:
			return normalized;
	}
}

const typeNameStarters = new Set([
	'anyarray',
	'anycompatible',
	'anycompatiblearray',
	'anyelement',
	'anyenum',
	'anynonarray',
	'bigint',
	'bit',
	'boolean',
	'bytea',
	'char',
	'character',
	'cstring',
	'date',
	'decimal',
	'double',
	'float',
	'int',
	'int2',
	'int4',
	'int8',
	'integer',
	'interval',
	'json',
	'jsonb',
	'name',
	'numeric',
	'oid',
	'real',
	'record',
	'smallint',
	'text',
	'time',
	'timestamp',
	'timestamptz',
	'timetz',
	'uuid',
	'varchar',
	'xml'
]);

function looksLikeTypeName(typeName: string) {
	const normalized = typeName.trim().toLowerCase().replace(/\s+/g, ' ');
	if (normalized === '') {
		return false;
	}
	if (normalized.includes('.')) {
		return true;
	}
	if (!normalized.includes(' ')) {
		return true;
	}
	const firstToken = normalized.split(' ')[0].replace(/\(\s*[^()]*\s*\)/g, '').replace(/\[\]$/, '');
	return typeNameStarters.has(firstToken);
}

function sameCompositeType(actual: string, declared: string) {
	if (!isNamedCompositeType(actual) || !isNamedCompositeType(declared)) {
		return false;
	}
	return getCompositeBaseName(actual) === getCompositeBaseName(declared);
}

function isNamedCompositeType(typeName: string) {
	if (typeName === 'record' || typeName === 'unknown' || isArrayType(typeName)) {
		return false;
	}
	return !numericTypeFamily.has(typeName)
		&& !temporalTypeFamily.has(typeName)
		&& !stringTypeFamily.has(typeName)
		&& !typeNameStarters.has(typeName);
}

function getCompositeBaseName(typeName: string) {
	return typeName.split('.').at(-1) || typeName;
}

function parseTableColumnDefinition(part: string): ResolvedTableColumn {
	const trimmed = part.trim();
	const firstSpaceIndex = trimmed.search(/\s/);
	if (firstSpaceIndex === -1) {
		throw new Error(`Invalid column definition: ${part}`);
	}
	const name = trimmed.slice(0, firstSpaceIndex).trim();
	const type = trimmed.slice(firstSpaceIndex).trim();
	if (name === '' || type === '') {
		throw new Error(`Invalid column definition: ${part}`);
	}
	return { name, type };
}

function splitTopLevelCommaList(input: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;

	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (char === '(') {
			depth++;
		} else if (char === ')') {
			depth = Math.max(0, depth - 1);
		} else if (char === ',' && depth === 0) {
			parts.push(input.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(input.slice(start).trim());

	return parts.filter((part) => part.length > 0);
}
