import type {
	GenericColumn,
	GenericParameter,
	RescriptQueryCheck,
	RescriptQueryDescriptor,
	ResolvedQuery
} from './query-resolver';
import {
	type JsonSchema,
	commandResponseSchema,
	createErrorEnvelope,
	createSuccessEnvelope,
	arraySchema,
	enumSchema,
	nullableSchema,
	objectSchema
} from './schemas';

export type RescriptErrorCode =
	| 'NO_SQL_PROVIDED'
	| 'INVALID_INPUT'
	| 'MISSING_VARIABLES'
	| 'ANALYZE_REQUIRES_ALLOW_SIDE_EFFECTS'
	| 'COMMAND_FAILED';

const QUERY_TYPE_VALUES = ['Select', 'Insert', 'Update', 'Delete', 'Copy'];

const parameterMetadataSchema = objectSchema(
	{
		name: { type: 'string' },
		dbType: { type: 'string' },
		notNull: { type: 'boolean' },
		path: { type: 'string' },
		listExpansion: { type: 'boolean' },
		driverArray: { type: 'boolean' },
		required: { type: 'boolean' },
		scope: enumSchema(['params', 'data'])
	},
	['name', 'dbType', 'notNull', 'path', 'listExpansion', 'driverArray', 'required', 'scope']
);

const columnMetadataSchema = objectSchema(
	{
		name: { type: 'string' },
		dbType: { type: 'string' },
		notNull: { type: 'boolean' }
	},
	['name', 'dbType', 'notNull']
);

const descriptorSchema = objectSchema(
	{
		kind: enumSchema(['static', 'dynamic']),
		queryType: enumSchema(QUERY_TYPE_VALUES),
		multipleRowsResult: { type: 'boolean' },
		parameters: arraySchema(parameterMetadataSchema),
		dataParameters: arraySchema(parameterMetadataSchema),
		resultColumns: arraySchema(columnMetadataSchema),
		orderByColumns: arraySchema({ type: 'string' })
	},
	['kind', 'queryType', 'multipleRowsResult', 'parameters', 'dataParameters', 'resultColumns', 'orderByColumns']
);

const checkMetadataSchema = objectSchema(
	{
		isDynamic: { type: 'boolean' },
		hasOrderBy: { type: 'boolean' },
		multipleRowsResult: { type: 'boolean' },
		requiresVariablesForExplain: { type: 'boolean' }
	},
	['isDynamic', 'hasOrderBy', 'multipleRowsResult', 'requiresVariablesForExplain']
);

const generateDataSchema = objectSchema(
	{
		name: { type: 'string' },
		sourceSql: { type: 'string' },
		rescript: { type: 'string' },
		originalTs: nullableSchema({ type: 'string' })
	},
	['name', 'sourceSql', 'rescript', 'originalTs']
);

const checkDataSchema = objectSchema(
	{
		name: { type: 'string' },
		sourceSql: { type: 'string' },
		preparedSql: { type: 'string' },
		descriptor: descriptorSchema,
		paramOrder: arraySchema({ type: 'string' }),
		variablesSchema: { type: 'object' },
		exampleVariables: {},
		metadata: checkMetadataSchema
	},
	['name', 'sourceSql', 'preparedSql', 'descriptor', 'paramOrder', 'variablesSchema', 'exampleVariables', 'metadata']
);

const inspectDataSchema = objectSchema(
	{
		name: { type: 'string' },
		sourceSql: { type: 'string' },
		preparedSql: { type: 'string' },
		descriptor: descriptorSchema,
		paramOrder: arraySchema({ type: 'string' }),
		variablesSchema: { type: 'object' },
		exampleVariables: {},
		resolved: { type: 'boolean' },
		executableSql: nullableSchema({ type: 'string' }),
		bindValues: nullableSchema(arraySchema({})),
		missingVariables: arraySchema({ type: 'string' })
	},
	[
		'name',
		'sourceSql',
		'preparedSql',
		'descriptor',
		'paramOrder',
		'variablesSchema',
		'exampleVariables',
		'resolved',
		'executableSql',
		'bindValues',
		'missingVariables'
	]
);

const explainDataSchema = objectSchema(
	{
		name: { type: 'string' },
		sourceSql: { type: 'string' },
		preparedSql: { type: 'string' },
		descriptor: descriptorSchema,
		paramOrder: arraySchema({ type: 'string' }),
		variablesSchema: { type: 'object' },
		exampleVariables: {},
		resolved: { type: 'boolean' },
		executableSql: { type: 'string' },
		bindValues: arraySchema({}),
		missingVariables: arraySchema({ type: 'string' }),
		analyze: { type: 'boolean' },
		plan: {}
	},
	[
		'name',
		'sourceSql',
		'preparedSql',
		'descriptor',
		'paramOrder',
		'variablesSchema',
		'exampleVariables',
		'resolved',
		'executableSql',
		'bindValues',
		'missingVariables',
		'analyze',
		'plan'
	]
);

const execDataSchema = objectSchema(
	{
		name: { type: 'string' },
		sourceSql: { type: 'string' },
		preparedSql: { type: 'string' },
		descriptor: descriptorSchema,
		paramOrder: arraySchema({ type: 'string' }),
		variablesSchema: { type: 'object' },
		exampleVariables: {},
		resolved: { type: 'boolean' },
		executableSql: { type: 'string' },
		bindValues: arraySchema({}),
		missingVariables: arraySchema({ type: 'string' }),
		rows: arraySchema({}),
		summary: { type: 'object' }
	},
	[
		'name',
		'sourceSql',
		'preparedSql',
		'descriptor',
		'paramOrder',
		'variablesSchema',
		'exampleVariables',
		'resolved',
		'executableSql',
		'bindValues',
		'missingVariables'
	]
);

export const responseSchemas = {
	generate: commandResponseSchema('generate', generateDataSchema),
	check: commandResponseSchema('check', checkDataSchema),
	inspect: commandResponseSchema('inspect', inspectDataSchema),
	explain: commandResponseSchema('explain', explainDataSchema),
	exec: commandResponseSchema('exec', execDataSchema)
} satisfies Record<'generate' | 'check' | 'inspect' | 'explain' | 'exec', JsonSchema>;

function createCommandSuccessEnvelope(
	command: keyof typeof responseSchemas,
	dialect: string,
	data: Record<string, unknown>
) {
	return createSuccessEnvelope(command, dialect, data, responseSchemas[command]);
}

function descriptorMetadata(descriptor: RescriptQueryDescriptor) {
	return {
		kind: descriptor.kind,
		queryType: descriptor.queryType,
		multipleRowsResult: descriptor.multipleRowsResult,
		parameters: descriptor.parameters,
		dataParameters: descriptor.kind === 'static' ? descriptor.data : [],
		resultColumns: descriptor.columns,
		orderByColumns: descriptor.orderByColumns
	};
}

function buildCheckLikeData(name: string, check: RescriptQueryCheck) {
	return {
		name,
		sourceSql: check.descriptor.sourceSql,
		preparedSql: check.descriptor.preparedSql,
		descriptor: descriptorMetadata(check.descriptor),
		paramOrder: check.paramOrder,
		variablesSchema: check.variablesSchema,
		exampleVariables: check.exampleVariables,
		metadata: check.metadata
	};
}

function buildInspectLikeData(name: string, resolved: ResolvedQuery) {
	return {
		name,
		sourceSql: resolved.descriptor.sourceSql,
		preparedSql: resolved.descriptor.preparedSql,
		descriptor: descriptorMetadata(resolved.descriptor),
		paramOrder: resolved.paramOrder,
		variablesSchema: resolved.variablesSchema,
		exampleVariables: resolved.exampleVariables,
		resolved: resolved.resolved,
		executableSql: resolved.executableSql,
		bindValues: resolved.bindValues,
		missingVariables: resolved.missingVariables
	};
}

export function buildGenerateResponse(
	name: string,
	dialect: string,
	sourceSql: string,
	rescript: string,
	originalTs?: string
) {
	return createCommandSuccessEnvelope('generate', dialect,
		{
			name,
			sourceSql,
			rescript,
			originalTs: originalTs ?? null
		}
	);
}

export function buildCheckResponse(name: string, dialect: string, check: RescriptQueryCheck) {
	return createCommandSuccessEnvelope('check', dialect, buildCheckLikeData(name, check));
}

export function buildInspectResponse(name: string, dialect: string, resolved: ResolvedQuery) {
	return createCommandSuccessEnvelope('inspect', dialect, buildInspectLikeData(name, resolved));
}

export function buildExplainResponse(name: string, dialect: string, resolved: ResolvedQuery, analyze: boolean, plan: unknown) {
	return createCommandSuccessEnvelope('explain', dialect,
		{
			...buildInspectLikeData(name, resolved),
			analyze,
			executableSql: resolved.executableSql,
			bindValues: resolved.bindValues,
			plan
		}
	);
}

export function buildExecResponse(
	name: string,
	dialect: string,
	resolved: ResolvedQuery,
	result: { rows?: unknown[]; summary?: Record<string, unknown> }
) {
	return createCommandSuccessEnvelope('exec', dialect,
		{
			...buildInspectLikeData(name, resolved),
			executableSql: resolved.executableSql,
			bindValues: resolved.bindValues,
			rows: result.rows || [],
			summary: result.summary || {}
		}
	);
}

export function buildErrorResponse(command: 'generate' | 'check' | 'inspect' | 'explain' | 'exec', code: RescriptErrorCode, message: string, details?: unknown) {
	return createErrorEnvelope(command, code, message, details);
}

export function buildMissingVariablesError(command: 'inspect' | 'explain' | 'exec', name: string, resolved: ResolvedQuery) {
	return buildErrorResponse(command, 'MISSING_VARIABLES', `Missing variables for query '${name}'.`, {
		missingVariables: resolved.missingVariables,
		variablesSchema: resolved.variablesSchema,
		exampleVariables: resolved.exampleVariables
	});
}

export type QueryDescriptorMetadata = ReturnType<typeof descriptorMetadata>;
export type CheckResponseEnvelope = ReturnType<typeof buildCheckResponse>;
export type InspectResponseEnvelope = ReturnType<typeof buildInspectResponse>;
export type ExplainResponseEnvelope = ReturnType<typeof buildExplainResponse>;
export type ExecResponseEnvelope = ReturnType<typeof buildExecResponse>;
export type GenerateResponseEnvelope = ReturnType<typeof buildGenerateResponse>;

export type ParameterMetadata = GenericParameter;
export type ColumnMetadata = GenericColumn;
