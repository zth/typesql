import { ResolvedFunctionMetadata, ResolvedTableColumn } from './function-resolution';

type BuiltinRecordColumnShape = ResolvedTableColumn & {
	isNullable?: boolean;
};

const NON_NULL_SCALAR_FUNCTION_TABLES = new Set([
	'generate_series',
	'generate_subscripts',
	'json_object_keys',
	'jsonb_object_keys'
]);

const BUILTIN_RECORD_FUNCTION_COLUMNS = new Map<string, BuiltinRecordColumnShape[]>([
	['pg_catalog.json_each', [
		{ name: 'key', type: 'text' },
		{ name: 'value', type: 'json' }
	]],
	['pg_catalog.json_each_text', [
		{ name: 'key', type: 'text' },
		{ name: 'value', type: 'text' }
	]],
	['pg_catalog.jsonb_each', [
		{ name: 'key', type: 'text' },
		{ name: 'value', type: 'jsonb' }
	]],
	['pg_catalog.jsonb_each_text', [
		{ name: 'key', type: 'text' },
		{ name: 'value', type: 'text' }
	]]
]);

function builtinFunctionKey(functionInfo: ResolvedFunctionMetadata) {
	return `${functionInfo.schema.toLowerCase()}.${functionInfo.functionName.toLowerCase()}`;
}

export function isAlwaysNonNullScalarFunctionTable(functionInfo: ResolvedFunctionMetadata): boolean {
	return functionInfo.schema.toLowerCase() === 'pg_catalog'
		&& NON_NULL_SCALAR_FUNCTION_TABLES.has(functionInfo.functionName.toLowerCase());
}

export function getBuiltinRecordFunctionColumns(functionInfo: ResolvedFunctionMetadata): BuiltinRecordColumnShape[] | null {
	const builtinColumns = BUILTIN_RECORD_FUNCTION_COLUMNS.get(builtinFunctionKey(functionInfo));
	return builtinColumns?.map(column => ({ ...column })) || null;
}
