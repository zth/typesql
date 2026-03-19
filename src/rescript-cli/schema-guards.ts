import type { PostgresSchemaInfo, SchemaInfo } from '../schema-info';

export function requireStandardSchemaInfo(schemaInfo: SchemaInfo | PostgresSchemaInfo): SchemaInfo {
	if (schemaInfo.kind === 'pg') {
		throw new Error('Expected a sqlite/mysql schema for this ReScript command.');
	}
	return schemaInfo;
}

export function requirePostgresSchemaInfo(schemaInfo: SchemaInfo | PostgresSchemaInfo): PostgresSchemaInfo {
	if (schemaInfo.kind !== 'pg') {
		throw new Error('Expected a postgres schema for this ReScript command.');
	}
	return schemaInfo;
}
