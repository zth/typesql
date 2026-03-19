export type JsonSchema = {
	$schema?: string;
	type?: string | string[];
	additionalProperties?: boolean;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	prefixItems?: JsonSchema[];
	minItems?: number;
	maxItems?: number;
	enum?: string[];
	const?: unknown;
	oneOf?: JsonSchema[];
	if?: JsonSchema;
	then?: JsonSchema;
	allOf?: JsonSchema[];
	format?: string;
	contentEncoding?: string;
	pattern?: string;
	[key: string]: unknown;
};

export const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

export const RESCRIPT_COMMANDS = ['generate', 'check', 'inspect', 'explain', 'exec'] as const;
export type RescriptCommandName = typeof RESCRIPT_COMMANDS[number];

const DIALECTS = ['pg', 'better-sqlite3', 'bun:sqlite', 'libsql', 'd1', 'mysql2'] as const;

export function createResponseEnvelopeSchema(): JsonSchema {
	return {
		$schema: JSON_SCHEMA_DRAFT,
		type: 'object',
		additionalProperties: false,
		properties: {
			command: {
				type: 'string',
				enum: [...RESCRIPT_COMMANDS]
			},
			ok: {
				type: 'boolean'
			},
			schemaVersion: {
				type: 'string'
			},
			dialect: {
				type: 'string',
				enum: [...DIALECTS]
			},
			data: {
				type: 'object'
			},
			error: {
				type: 'object',
				additionalProperties: false,
				properties: {
					code: { type: 'string' },
					message: { type: 'string' },
					details: {}
				},
				required: ['code', 'message']
			},
			responseSchema: {
				type: 'object'
			}
		},
		required: ['command', 'ok', 'schemaVersion'],
		allOf: [
			{
				if: {
					properties: {
						ok: { const: true }
					}
				},
				then: {
					required: ['data']
				}
			},
			{
				if: {
					properties: {
						ok: { const: false }
					}
				},
				then: {
					required: ['error']
				}
			}
		]
	};
}

export function createSuccessEnvelope(
	command: RescriptCommandName,
	dialect: string,
	data: Record<string, unknown>,
	responseSchema: JsonSchema
) {
	return {
		command,
		ok: true,
		schemaVersion: '1',
		dialect,
		data,
		responseSchema
	};
}

export function createErrorEnvelope(command: RescriptCommandName, code: string, message: string, details?: unknown) {
	return {
		command,
		ok: false,
		schemaVersion: '1',
		error: {
			code,
			message,
			...(details === undefined ? {} : { details })
		}
	};
}

export function objectSchema(properties: Record<string, JsonSchema>, required: string[] = [], additionalProperties = false): JsonSchema {
	return {
		type: 'object',
		additionalProperties,
		properties,
		...(required.length === 0 ? {} : { required })
	};
}

export function arraySchema(items: JsonSchema, minItems?: number): JsonSchema {
	return {
		type: 'array',
		items,
		...(minItems == null ? {} : { minItems })
	};
}

export function enumSchema(values: string[]): JsonSchema {
	return {
		type: 'string',
		enum: values
	};
}

export function nullableSchema(schema: JsonSchema): JsonSchema {
	if (Array.isArray(schema.type)) {
		return { ...schema, type: [...schema.type, 'null'] };
	}
	if (schema.oneOf) {
		return {
			oneOf: [...schema.oneOf, { type: 'null' }]
		};
	}
	return {
		...schema,
		type: schema.type ? [schema.type, 'null'] : ['null']
	};
}

export function propertyFromSchema(schema: JsonSchema): unknown {
	if (schema.const !== undefined) return schema.const;
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
	if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return propertyFromSchema(schema.oneOf[0]);
	if (Array.isArray(schema.type)) {
		const firstNonNull = schema.type.find((item) => item !== 'null');
		if (firstNonNull) {
			return propertyFromSchema({ ...schema, type: firstNonNull });
		}
		return null;
	}
	switch (schema.type) {
		case 'object': {
			const result: Record<string, unknown> = {};
			const required = new Set<string>(schema.required || []);
			const properties = schema.properties || {};
			for (const name of Object.keys(properties)) {
				if (required.has(name)) {
					result[name] = propertyFromSchema(properties[name]);
				}
			}
			return result;
		}
		case 'array': {
			if (schema.prefixItems && schema.prefixItems.length > 0) {
				return schema.prefixItems.map((item: JsonSchema) => propertyFromSchema(item));
			}
			if ((schema.minItems || 0) > 0) {
				return [propertyFromSchema(schema.items || {})];
			}
			return [];
		}
		case 'integer':
			return 1;
		case 'number':
			return 1;
		case 'boolean':
			return true;
		case 'string':
			if (schema.format === 'date') {
				return '2024-01-01';
			}
			if (schema.format === 'date-time') {
				return '2024-01-01T00:00:00.000Z';
			}
			if (schema.contentEncoding === 'base64') {
				return 'AQID';
			}
			return 'example';
		case 'null':
			return null;
		default:
			return {};
	}
}

export function commandResponseSchema(command: RescriptCommandName, dataSchema: JsonSchema): JsonSchema {
	const envelope = createResponseEnvelopeSchema();
	return {
		...envelope,
		properties: {
			...envelope.properties,
			command: {
				type: 'string',
				const: command
			},
			data: dataSchema
		}
	};
}
