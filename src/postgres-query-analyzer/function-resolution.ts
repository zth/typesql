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

export function resolvePostgresFunction(functionName: ResolveFunctionName, userFunctions: UserFunctionSchema[], builtinFunctions: PostgresBuiltinFunctionSchema[]): FunctionResolution {
	const userMatches = findMatchingUserFunctions(functionName, userFunctions);
	if (userMatches.length === 1) {
		return { status: 'resolved', value: userMatches[0] };
	}
	if (userMatches.length > 1) {
		return { status: 'ambiguous', candidates: userMatches };
	}

	const builtinMatches = findMatchingBuiltinFunctions(functionName, builtinFunctions);
	if (builtinMatches.length === 1) {
		return { status: 'resolved', value: builtinMatches[0] };
	}
	if (builtinMatches.length > 1) {
		return { status: 'ambiguous', candidates: builtinMatches };
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
