#!/usr/bin/env node
import fs from 'node:fs';
import dotenv from 'dotenv';
import path from 'node:path';
import chokidar from 'chokidar';
import yargs from 'yargs';
import { generateTsFile, writeFile } from './codegen/code-generator';
import { generateInsertStatement, generateUpdateStatement, generateDeleteStatement, generateSelectStatement } from './sql-generator';
import type { ColumnSchema, Table } from './mysql-query-analyzer/types';
import type { TypeSqlConfig, SqlGenOption, DatabaseClient, TypeSqlDialect, SQLiteClient, CrudQueryType } from './types';
import { type Either, isLeft, left } from 'fp-ts/lib/Either';
import { globSync } from 'glob';
import { closeClient, createClient, loadSchemaInfo, loadTableSchema, PostgresSchemaInfo, SchemaInfo, selectTables } from './schema-info';
import { generateCrud } from './codegen/sqlite';
import { generateCrud as generatePgCrud } from './codegen/pg';
import uniqBy from 'lodash.uniqby';
import { buildExportList, buildExportMap, loadConfig, resolveTsFilePath } from './load-config';
import { PostgresColumnSchema } from './drivers/types';
import { generateReScriptFromMySQL, generateReScriptFromPostgres, generateReScriptFromSQLite } from './rescript';
import net from 'node:net';
import { createCodeBlockWriter } from './codegen/shared/codegen-util';

const CRUD_FOLDER = 'crud';

function parseArgs() {
	return yargs
		.usage('Usage: $0 [options] DIRECTORY')
		.option('config', {
			describe: 'Path to the TypeSQL config file (e.g., ./src/sql/typesql.json)',
			type: 'string',
			default: './typesql.json'
		})
		.option('env-file', {
			describe: 'Path to the .env file to load',
			type: 'string'
		})
		.command('init', 'generate config file', () => {
			const config: TypeSqlConfig = {
				databaseUri: 'mysql://root:password@localhost/mydb',
				sqlDir: './sqls',
				client: 'mysql2',
				includeCrudTables: []
			};
			const configPath = './typesql.json';
			writeFile(configPath, JSON.stringify(config, null, 4));
			console.log('Init file generated:', configPath);
		})
		.command(
			['compile [options]', 'c [options]'],
			'Compile the queries and generate ts files',
			(yargs) => {
				return yargs.option('watch', {
					alias: 'w',
					describe: 'Watch for changes in the folders',
					type: 'boolean',
					default: false
				});
			},
			(args) => {
				loadEnvFileIfPresent(args.envFile as string | undefined);
				const config = loadConfig(args.config);
				compile(args.watch, config);
			}
		)
		.command(
			['generate <option> <sql-name>', 'g <option> <sql-name>'],
			'generate sql queries',
			(yargs) => {
				return yargs
					.positional('option', {
						type: 'string',
						demandOption: true,
						choices: ['select', 'insert', 'update', 'delete', 's', 'i', 'u', 'd']
					})
					.positional('sql-name', {
						type: 'string',
						demandOption: true
					})
					.option('table', {
						alias: 't',
						type: 'string',
						demandOption: true
					})
					.strict();
			},
			(args) => {
				const config = loadConfig(args.config);
				const genOption = args.option as SqlGenOption;
				writeSql(genOption, args.table, args['sql-name'], config);
			}
		)
		.command(
			['rescript'],
			'Generate ReScript from a SQL string (via --sql or stdin)',
			(yargs) => {
				return yargs
					.option('sql', {
						type: 'string',
						describe: 'SQL string to compile (if omitted, reads from stdin)'
					})
					.option('name', {
						alias: 'n',
						type: 'string',
						demandOption: true,
						describe: 'Logical query name (e.g. selectUsers)'
					})
					.strict();
			},
			async (args) => {
				loadEnvFileIfPresent(args.envFile as string | undefined);
				const config = loadConfig(args.config as string);
				const sqlFromArg = args.sql as string | undefined;
				const sql = await readStdinIfNeeded(sqlFromArg);
				if (!sql || sql.trim().length === 0) {
					console.error('No SQL provided. Pass --sql or pipe SQL via stdin.');
					process.exitCode = 1;
					return;
				}

				try {
					const queryName = args.name as string;
					const { rescript } = await generateReScriptFromConfig(config, queryName, sql);
					process.stdout.write(rescript + '\n');
				} catch (err: any) {
					console.error(`Error: ${String(err?.message || err)}.`);
					process.exitCode = 1;
				}
			}
		)
		.command(
			['daemon'],
			'Start a long-lived daemon that accepts requests via IPC (Unix socket) or stdio',
			(yargs) => {
				return yargs
					.option('socket', {
						type: 'string',
						describe: 'Unix socket path for IPC (default: /tmp/typesql.sock)'
					})
					.option('stdio', {
						type: 'boolean',
						default: false,
						describe: 'Use stdio for requests/responses (NDJSON)'
					})
					.strict();
			},
			async (args) => {
				loadEnvFileIfPresent(args.envFile as string | undefined);
				const config = loadConfig(args.config as string);
				const { databaseUri, client: dialect, attach, loadExtensions, authToken } = config;
				const dbClientResult = await createClient(databaseUri, dialect, attach, loadExtensions, authToken);
				if (dbClientResult.isErr()) {
					console.error(`Error: ${dbClientResult.error.description}.`);
					process.exitCode = 1;
					return;
				}
				const dbClient = dbClientResult.value;
				const schemaInfoResult = await loadSchemaInfo(dbClient, config.schemas);
				if (schemaInfoResult.isErr()) {
					console.error(`Error: ${schemaInfoResult.error.description}.`);
					await closeClient(dbClient);
					process.exitCode = 1;
					return;
				}
				const schemaInfo = schemaInfoResult.value;

				const useStdio = Boolean(args.stdio);
				if (useStdio) {
					startStdioDaemon(dbClient, schemaInfo);
					return; // keep process alive
				}

				const socketPath = (args.socket as string) || '/tmp/typesql.sock';
				startSocketDaemon(socketPath, dbClient, schemaInfo);
			}
		)

		.command(
			['get-embed'],
			'Generate ReScript from SQL provided as JSON on stdin (expects { data, id })',
			(yargs) =>
				yargs
					.option('config', {
						describe: 'Path to the TypeSQL config file (e.g., ./src/sql/typesql.json)',
						type: 'string',
						default: './typesql.json'
					})
					.strict(),
			async (args) => {
				try {
					loadEnvFileIfPresent(args.envFile as string | undefined);
					const inputStr = await readAllStdin();
					const input = JSON.parse(inputStr || '{}');
					const c: { query: string; id?: string } =
						typeof input?.data === 'object' && input.data !== null
							? input.data
							: {
									query: input.data,
									id: input.id
								};
					const sql = String(c.query);
					const queryName = String(c.id ?? 'query');
					if (!sql || sql.trim().length === 0) {
						process.stdout.write(JSON.stringify({ status: 'error', errors: [{ message: 'No SQL provided in input.data' }] }));
						process.exitCode = 0;
						return;
					}

					const config = loadConfig(args.config as string);
					const { rescript } = await generateReScriptFromConfig(config, queryName, sql);
					process.stdout.write(JSON.stringify({ status: 'ok', code: rescript }));
				} catch (err: any) {
					process.stdout.write(JSON.stringify({ status: 'error', errors: [{ message: String(err?.message || err) }] }));
					process.exitCode = 0;
				}
			}
		)

		.demand(1, 'Please specify one of the commands!')
		.wrap(null)
		.strict().argv;
}

function validateDirectories(dir: string) {
	if (!fs.statSync(dir).isDirectory()) {
		console.log(`The argument is not a directory: ${dir}`);
	}
}

function watchDirectories(
	client: DatabaseClient,
	sqlDir: string,
	outDir: string,
	dbSchema: SchemaInfo | PostgresSchemaInfo,
	config: TypeSqlConfig
) {
	const dirGlob = `${sqlDir}/**/*.sql`;

	chokidar
		.watch(dirGlob, {
			awaitWriteFinish: {
				stabilityThreshold: 100
			}
		})
		.on('add', (path) => rewiteFiles(client, path, sqlDir, outDir, dbSchema, isCrudFile(sqlDir, path), config))
		.on('change', (path) => rewiteFiles(client, path, sqlDir, outDir, dbSchema, isCrudFile(sqlDir, path), config));
}

async function rewiteFiles(
	client: DatabaseClient,
	sqlPath: string,
	sqlDir: string,
	outDir: string,
	schemaInfo: SchemaInfo | PostgresSchemaInfo,
	isCrudFile: boolean,
	config: TypeSqlConfig
) {
	const tsFilePath = resolveTsFilePath(sqlPath, sqlDir, outDir);
	await generateTsFile(client, sqlPath, tsFilePath, schemaInfo, isCrudFile);
	const tsDir = path.dirname(tsFilePath);
	writeIndexFileFor(tsDir, config);
}

async function main() {
	parseArgs();
}

async function compile(watch: boolean, config: TypeSqlConfig) {
	const { sqlDir, outDir = sqlDir, databaseUri, client: dialect, attach, loadExtensions, authToken } = config;
	validateDirectories(sqlDir);

	const databaseClientResult = await createClient(databaseUri, dialect, attach, loadExtensions, authToken);
	if (databaseClientResult.isErr()) {
		console.error(`Error: ${databaseClientResult.error.description}.`);
		return;
	}

	const includeCrudTables = config.includeCrudTables || [];
	const databaseClient = databaseClientResult.value;

	const dbSchema = await loadSchemaInfo(databaseClient, config.schemas);
	if (dbSchema.isErr()) {
		console.error(`Error: ${dbSchema.error.description}.`);
		await closeClient(databaseClient);
		return;
	}

	await generateCrudTables(outDir, dbSchema.value, includeCrudTables);
	const dirGlob = `${sqlDir}/**/*.sql`;

	const sqlFiles = globSync(dirGlob);

	const filesGeneration = sqlFiles.map((sqlPath) =>
		generateTsFile(databaseClient, sqlPath, resolveTsFilePath(sqlPath, sqlDir, outDir), dbSchema.value, isCrudFile(sqlDir, sqlPath))
	);
	await Promise.all(filesGeneration);

	writeIndexFile(outDir, config);

	if (watch) {
		console.log('watching mode!');
		watchDirectories(databaseClient, sqlDir, outDir, dbSchema.value, config);
	} else {
		await closeClient(databaseClient);
	}
}

function writeIndexFile(outDir: string, config: TypeSqlConfig) {
	const exportMap = buildExportMap(outDir);
	for (const [dir, files] of exportMap.entries()) {
		const indexContent = generateIndexContent(files, config.moduleExtension);
		const indexPath = path.join(dir, 'index.ts');
		writeFile(indexPath, indexContent);
	}
}

function writeIndexFileFor(tsDir: string, config: TypeSqlConfig) {
	if (fs.existsSync(tsDir)) {
		const tsFiles = buildExportList(tsDir);
		const indexContent = generateIndexContent(tsFiles, config.moduleExtension);
		const tsPath = path.join(tsDir, 'index.ts');
		writeFile(tsPath, indexContent);
	}
}

//Move to code-generator
function generateIndexContent(tsFiles: string[], moduleExtension: TypeSqlConfig['moduleExtension']) {
	const writer = createCodeBlockWriter();
	for (const filePath of tsFiles) {
		const fileName = path.basename(filePath, '.ts'); //remove the ts extension
		const suffix = moduleExtension ? `.${moduleExtension}` : '.js';
		writer.writeLine(`export * from "./${fileName}${suffix}";`);
	}
	return writer.toString();
}

async function writeSql(stmtType: SqlGenOption, tableName: string, queryName: string, config: TypeSqlConfig): Promise<boolean> {
	const { sqlDir, databaseUri, client: dialect } = config;
	const clientResult = await createClient(databaseUri, dialect);
	if (clientResult.isErr()) {
		console.error(clientResult.error.name);
		return false;
	}

	const client = clientResult.value;
	try {
		const columnsOption = await loadTableSchema(client, tableName);
		if (columnsOption.isErr()) {
			console.error(columnsOption.error.description);
			return false;
		}

		const columns = columnsOption.value;
		const filePath = `${sqlDir}/${queryName}`;

		const generatedOk = checkAndGenerateSql(client.type, filePath, stmtType, tableName, columns);
		return generatedOk;
	} finally {
		await closeClient(client);
	}
}

function checkAndGenerateSql(
	dialect: TypeSqlDialect,
	filePath: string,
	stmtType: SqlGenOption,
	tableName: string,
	columns: ColumnSchema[]
) {
	if (columns.length === 0) {
		console.error(`Got no columns for table '${tableName}'. Did you type the table name correclty?`);
		return false;
	}

	const generatedSql = generateSql(dialect, stmtType, tableName, columns);
	writeFile(filePath, generatedSql);
	console.log('Generated file:', filePath);
	return true;
}

function generateSql(dialect: TypeSqlDialect, stmtType: SqlGenOption, tableName: string, columns: ColumnSchema[]) {
	switch (stmtType) {
		case 'select':
		case 's':
			return generateSelectStatement(dialect, tableName, columns);
		case 'insert':
		case 'i':
			return generateInsertStatement(dialect, tableName, columns);
		case 'update':
		case 'u':
			return generateUpdateStatement(dialect, tableName, columns);
		case 'delete':
		case 'd':
			return generateDeleteStatement(dialect, tableName, columns);
	}
}

async function readStdinIfNeeded(argSql?: string): Promise<string> {
	if (argSql != null && argSql.length > 0) return argSql;
	// If stdin is not a TTY, read it entirely
	if (!process.stdin.isTTY) {
		return readAllStdin();
	}
	return '';
}

async function readAllStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function loadEnvFileIfPresent(envFile?: string) {
	if (!envFile) return;
	if (fs.existsSync(envFile)) {
		dotenv.config({ path: envFile, quiet: true });
	} else {
		console.warn(`Warning: .env file not found: ${envFile}`);
	}
}

async function generateReScriptFromConfig(config: TypeSqlConfig, queryName: string, sql: string) {
	const { databaseUri, client: dialect, attach, loadExtensions, authToken } = config;
	const dbClientResult = await createClient(databaseUri, dialect, attach, loadExtensions, authToken);
	if (dbClientResult.isErr()) {
		throw new Error(dbClientResult.error.description);
	}
	const dbClient = dbClientResult.value;
	try {
		const schemaInfoResult = await loadSchemaInfo(dbClient, config.schemas);
		if (schemaInfoResult.isErr()) {
			throw new Error(schemaInfoResult.error.description);
		}
		return await generateReScriptWithClient(dbClient, schemaInfoResult.value, queryName, sql);
	} finally {
		await closeClient(dbClient);
	}
}

async function generateReScriptWithClient(
	dbClient: DatabaseClient,
	schemaInfo: SchemaInfo | PostgresSchemaInfo,
	queryName: string,
	sql: string
): Promise<{ rescript: string; originalTs: string }> {
	if (dbClient.type === 'mysql2') {
		return generateReScriptFromMySQL({
			databaseClient: dbClient,
			queryName,
			sql,
			schemaInfo: schemaInfo as SchemaInfo,
			isCrudFile: false
		});
	}
	if (dbClient.type === 'pg') {
		return generateReScriptFromPostgres({
			databaseClient: dbClient,
			queryName,
			sql,
			schemaInfo: schemaInfo as PostgresSchemaInfo,
			isCrudFile: false
		});
	}
	return generateReScriptFromSQLite({
		databaseClient: dbClient,
		queryName,
		sql,
		schemaInfo: schemaInfo as SchemaInfo,
		isCrudFile: false
	});
}

type DaemonRequest =
	| {
			action: 'rescript';
			name: string;
			sql: string;
	  }
	| { action: 'shutdown' };

type DaemonResponse =
	| { ok: true; action: 'rescript'; name: string; rescript: string; originalTs?: string }
	| { ok: true; action: 'shutdown' }
	| { ok: false; error: string };

function writeJsonLine(stream: NodeJS.WritableStream, obj: any) {
	stream.write(JSON.stringify(obj) + '\n');
}

function startSocketDaemon(socketPath: string, dbClient: DatabaseClient, schemaInfo: SchemaInfo | PostgresSchemaInfo) {
	try {
		if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
	} catch {}
	const server = net.createServer((socket) => {
		let buf = '';
		socket.on('data', async (chunk) => {
			buf += chunk.toString('utf8');
			let idx;
			while ((idx = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				if (!line.trim()) continue;
				try {
					const req = JSON.parse(line) as DaemonRequest;
					await handleDaemonRequest(req, dbClient, schemaInfo, {
						write: (resp) => socket.write(JSON.stringify(resp) + '\n')
					});
				} catch (e: any) {
					socket.write(JSON.stringify({ ok: false, error: String(e?.message || e) }) + '\n');
				}
			}
		});
	});
	server.on('error', (err) => {
		console.error('IPC server error:', err);
	});
	server.listen(socketPath, () => {
		console.error(`TypeSQL daemon listening on ${socketPath}`);
	});
	const cleanup = () => {
		try {
			server.close();
		} catch {}
		try {
			if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
		} catch {}
		closeClient(dbClient);
		process.exit(0);
	};
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
}

function startStdioDaemon(dbClient: DatabaseClient, schemaInfo: SchemaInfo | PostgresSchemaInfo) {
	console.error('TypeSQL daemon listening on stdio (NDJSON)');
	let buf = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', async (chunk) => {
		buf += chunk.toString();
		let idx;
		while ((idx = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (!line.trim()) continue;
			try {
				const req = JSON.parse(line) as DaemonRequest;
				await handleDaemonRequest(req, dbClient, schemaInfo, {
					write: (resp) => writeJsonLine(process.stdout, resp)
				});
			} catch (e: any) {
				writeJsonLine(process.stdout, { ok: false, error: String(e?.message || e) } satisfies DaemonResponse);
			}
		}
	});
	const cleanup = () => {
		closeClient(dbClient);
		process.exit(0);
	};
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
}

async function handleDaemonRequest(
	req: DaemonRequest,
	dbClient: DatabaseClient,
	schemaInfo: SchemaInfo | PostgresSchemaInfo,
	conn: { write: (resp: DaemonResponse) => void }
): Promise<void> {
	if (req.action === 'shutdown') {
		conn.write({ ok: true, action: 'shutdown' });
		process.kill(process.pid, 'SIGTERM');
		return;
	}
	if (req.action === 'rescript') {
		const { name, sql } = req;
		try {
			const { rescript, originalTs } = await generateReScriptWithClient(dbClient, schemaInfo, name, sql);
			conn.write({ ok: true, action: 'rescript', name, rescript, originalTs });
			return;
		} catch (e: any) {
			conn.write({ ok: false, error: String(e?.message || e) });
			return;
		}
	}
	conn.write({ ok: false, error: 'Unknown action' });
	return;
}

main().catch((err: any) => {
	console.error(String(err?.message || err));
	process.exitCode = 1;
});

function _filterTables(schemaInfo: SchemaInfo | PostgresSchemaInfo, includeCrudTables: string[]) {
	const allTables = schemaInfo.columns.map((col) => ({ schema: col.schema, table: col.table }) satisfies Table);
	const uniqueTables = uniqBy(allTables, (item) => `${item.schema}:${item.table}`);
	const filteredTables = filterTables(uniqueTables, includeCrudTables);
	return filteredTables;
}

async function generateCrudTables(sqlFolderPath: string, schemaInfo: SchemaInfo | PostgresSchemaInfo, includeCrudTables: string[]) {
	const filteredTables = _filterTables(schemaInfo, includeCrudTables);
	for (const tableInfo of filteredTables) {
		const tableName = tableInfo.table;
		const filePath = `${sqlFolderPath}/${CRUD_FOLDER}/${tableName}/`;
		if (schemaInfo.kind === 'mysql2') {
			const columns = schemaInfo.columns.filter((col) => col.table === tableName);
			checkAndGenerateSql(schemaInfo.kind, `${filePath}select-from-${tableName}.sql`, 'select', tableName, columns);
			checkAndGenerateSql(schemaInfo.kind, `${filePath}insert-into-${tableName}.sql`, 'insert', tableName, columns);
			checkAndGenerateSql(schemaInfo.kind, `${filePath}update-${tableName}.sql`, 'update', tableName, columns);
			checkAndGenerateSql(schemaInfo.kind, `${filePath}delete-from-${tableName}.sql`, 'delete', tableName, columns);
		} else {
			generateAndWriteCrud(schemaInfo.kind, `${filePath}select-from-${tableName}.ts`, 'Select', tableName, schemaInfo.columns);
			generateAndWriteCrud(schemaInfo.kind, `${filePath}insert-into-${tableName}.ts`, 'Insert', tableName, schemaInfo.columns);
			generateAndWriteCrud(schemaInfo.kind, `${filePath}update-${tableName}.ts`, 'Update', tableName, schemaInfo.columns);
			generateAndWriteCrud(schemaInfo.kind, `${filePath}delete-from-${tableName}.ts`, 'Delete', tableName, schemaInfo.columns);
		}
	}
}

function generateAndWriteCrud(
	client: 'pg' | SQLiteClient,
	filePath: string,
	queryType: CrudQueryType,
	tableName: string,
	columns: ColumnSchema[] | PostgresColumnSchema[]
) {
	const content =
		client === 'pg'
			? generatePgCrud(queryType, tableName, columns as PostgresColumnSchema[])
			: generateCrud(client, queryType, tableName, columns as ColumnSchema[]);
	writeFile(filePath, content);
	console.log('Generated file:', filePath);
}

function filterTables(allTables: Table[], includeCrudTables: string[]) {
	const selectAll = includeCrudTables.find((filter) => filter === '*');
	return selectAll ? allTables : allTables.filter((t) => includeCrudTables.find((t2) => t.table === t2) != null);
}

async function selectAllTables(client: DatabaseClient): Promise<Either<string, Table[]>> {
	const selectTablesResult = await selectTables(client);
	if (isLeft(selectTablesResult)) {
		return left(`Error selecting table names: ${selectTablesResult.left.description}`);
	}
	return selectTablesResult;
}

//https://stackoverflow.com/a/45242825
function isCrudFile(sqlDir: string, sqlFile: string): boolean {
	const relative = path.relative(`${sqlDir}/${CRUD_FOLDER}`, sqlFile);
	const result = relative != null && !relative.startsWith('..') && !path.isAbsolute(relative);
	return result;
}
