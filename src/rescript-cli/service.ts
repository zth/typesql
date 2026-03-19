import { loadConfig } from '../load-config';
import { generateReScriptFromMySQL, generateReScriptFromPostgres, generateReScriptFromSQLite } from '../rescript';
import { closeClient, createClient, loadSchemaInfo, PostgresSchemaInfo, SchemaInfo } from '../schema-info';
import type { DatabaseClient, TypeSqlConfig } from '../types';
import { requirePostgresSchemaInfo, requireStandardSchemaInfo } from './schema-guards';

export type RescriptSchemaInfo = SchemaInfo | PostgresSchemaInfo;

export type RescriptContext = {
	config: TypeSqlConfig;
	dbClient: DatabaseClient;
	schemaInfo: RescriptSchemaInfo;
	close: () => Promise<void>;
};

export async function openRescriptContext(configPath: string): Promise<RescriptContext> {
	const config = loadConfig(configPath);
	const { databaseUri, client: dialect, attach, loadExtensions, authToken } = config;
	const dbClientResult = await createClient(databaseUri, dialect, attach, loadExtensions, authToken);
	if (dbClientResult.isErr()) {
		throw new Error(dbClientResult.error.description);
	}

	const dbClient = dbClientResult.value;
	const schemaInfoResult = await loadSchemaInfo(dbClient, config.schemas);
	if (schemaInfoResult.isErr()) {
		await closeClient(dbClient);
		throw new Error(schemaInfoResult.error.description);
	}

	return {
		config,
		dbClient,
		schemaInfo: schemaInfoResult.value,
		close: async () => {
			await closeClient(dbClient);
		}
	};
}

export async function withRescriptContext<T>(configPath: string, callback: (context: RescriptContext) => Promise<T>): Promise<T> {
	const context = await openRescriptContext(configPath);
	try {
		return await callback(context);
	} finally {
		await context.close();
	}
}

export async function generateReScriptFromConfigPath(configPath: string, queryName: string, sql: string) {
	return withRescriptContext(configPath, async ({ dbClient, schemaInfo }) => generateReScriptWithClient(dbClient, schemaInfo, queryName, sql));
}

export async function generateReScriptWithClient(
	dbClient: DatabaseClient,
	schemaInfo: RescriptSchemaInfo,
	queryName: string,
	sql: string
): Promise<{ rescript: string; originalTs: string }> {
	if (dbClient.type === 'mysql2') {
		return generateReScriptFromMySQL({
			databaseClient: dbClient,
			queryName,
			sql,
			schemaInfo: requireStandardSchemaInfo(schemaInfo),
			isCrudFile: false
		});
	}
	if (dbClient.type === 'pg') {
		return generateReScriptFromPostgres({
			databaseClient: dbClient,
			queryName,
			sql,
			schemaInfo: requirePostgresSchemaInfo(schemaInfo),
			isCrudFile: false
		});
	}
	return generateReScriptFromSQLite({
		databaseClient: dbClient,
		queryName,
		sql,
		schemaInfo: requireStandardSchemaInfo(schemaInfo),
		isCrudFile: false
	});
}
