import type { Argv, CommandModule } from 'yargs';
import {
	errorMessage,
	isRecord,
	loadEnvFileIfPresent,
	parseJsonInput,
	readAllStdin,
	readBooleanFlag,
	readJsonFile,
	readOptionalString,
	readRequiredString,
	readStdinIfNeeded,
	requireRecord,
	writeJsonOutput
} from '../cli-io';
import { startSocketDaemon, startStdioDaemon } from './daemon';
import { resolveQueryWithGeneratedCode } from './generated-query-runtime';
import { checkRescriptQuery, execRescriptQuery, explainRescriptQuery, inspectCheckedRescriptQuery } from './query-resolver';
import type { ResolvedQuery } from './query-resolver';
import {
	buildCheckResponse,
	buildErrorResponse,
	buildExecResponse,
	buildExplainResponse,
	buildGenerateResponse,
	buildInspectResponse,
	buildMissingVariablesError,
	type RescriptErrorCode
} from './response';
import { generateReScriptWithClient, openRescriptContext, withRescriptContext } from './service';

type BaseArgs = {
	config: string;
	envFile?: string;
};

type NamedSqlArgs = BaseArgs & {
	name: string;
	sql?: string;
};

type GenerateArgs = NamedSqlArgs & {
	raw: boolean;
};

type VariableArgs = NamedSqlArgs & {
	vars?: string;
	varsFile?: string;
};

type DaemonArgs = BaseArgs & {
	stdio?: boolean;
	socket?: string;
};

type ExplainArgs = VariableArgs & {
	analyze?: boolean;
	allowSideEffects?: boolean;
};

type ToolCommandName = 'check' | 'inspect' | 'explain' | 'exec';
type JsonCommandContext = Parameters<Parameters<typeof withRescriptContext>[1]>[0];
type JsonCommandResponse = {
	ok?: boolean;
};
type GetEmbedInput = {
	query: string;
	id: string;
};

const generateCommandModule: CommandModule = {
	command: 'generate',
	describe: 'Generate embedded ReScript code from a SQL string.',
	builder: buildGenerateCommand,
	handler: (args) => handleGenerateCommand(parseGenerateArgs(args))
};

const daemonCommandModule: CommandModule = {
	command: 'daemon',
	describe: 'Start the ReScript daemon used by embedded-SQL tooling.',
	builder: buildDaemonCommand,
	handler: (args) => handleDaemonCommand(parseDaemonArgs(args))
};

const checkCommandModule: CommandModule = {
	command: 'check',
	describe: 'Validate a ReScript embedded query and describe the expected variable shape.',
	builder: buildCheckCommand,
	handler: (args) => handleCheckCommand(parseNamedSqlArgs(args))
};

const inspectCommandModule: CommandModule = {
	command: 'inspect',
	describe: 'Resolve a ReScript embedded query into executable SQL and bind values.',
	builder: buildInspectCommand,
	handler: (args) => handleInspectCommand(parseVariableArgs(args))
};

const explainCommandModule: CommandModule = {
	command: 'explain',
	describe: 'Run EXPLAIN or EXPLAIN ANALYZE for a resolved ReScript embedded query.',
	builder: buildExplainCommand,
	handler: (args) => handleExplainCommand(parseExplainArgs(args))
};

const execCommandModule: CommandModule = {
	command: 'exec',
	describe: 'Execute a ReScript embedded query with explicit variables.',
	builder: buildExecCommand,
	handler: (args) => handleExecCommand(parseVariableArgs(args))
};

const daemonAliasCommandModule: CommandModule = {
	command: 'daemon',
	describe: 'Compatibility alias for `typesql rescript daemon`.',
	builder: buildDaemonCommand,
	handler: (args) => handleDaemonCommand(parseDaemonArgs(args))
};

const getEmbedCommandModule: CommandModule = {
	command: 'get-embed',
	describe: 'Compatibility alias that returns JSON-wrapped generated ReScript code for embedded SQL.',
	builder: (yargs) => yargs.strict(),
	handler: (args) => handleGetEmbedCommand(parseBaseArgs(args))
};

export function registerRescriptCommands(yargs: Argv) {
	return yargs
		.command(
			'rescript',
			'ReScript embedded SQL command family. Use this to generate code, inspect resolved SQL, explain plans, and execute queries.',
			(rescriptYargs) =>
				rescriptYargs
					.command(generateCommandModule)
					.command(daemonCommandModule)
					.command(checkCommandModule)
					.command(inspectCommandModule)
					.command(explainCommandModule)
					.command(execCommandModule)
					.strict(),
			() => {
				process.stdout.write(getRescriptHelpText());
			}
		)
		.command(daemonAliasCommandModule)
		.command(getEmbedCommandModule);
}

function addSqlCommandOptions(yargs: Argv) {
	return yargs
		.option('sql', {
			type: 'string',
			describe: 'SQL string to process. If omitted, the command reads SQL from stdin.'
		})
		.option('name', {
			alias: 'n',
			type: 'string',
			demandOption: true,
			describe: 'Logical embedded-query name, for example `selectUsers`.'
		})
		.strict();
}

function addVariableOptions(yargs: Argv) {
	return yargs
		.option('vars', {
			type: 'string',
			describe: 'Variables JSON to use when resolving or executing the query.'
		})
		.option('vars-file', {
			type: 'string',
			describe: 'Path to a JSON file containing variables for the query.'
		});
}

function buildGenerateCommand(yargs: Argv) {
	return addSqlCommandOptions(yargs)
		.option('raw', {
			type: 'boolean',
			default: false,
			describe: 'Print only the generated ReScript code instead of the JSON response envelope.'
		})
		.example(
			'$0 rescript generate --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id"',
			'Generate ReScript and return a JSON response with the code and response schema.'
		)
		.example(
			'$0 rescript generate --raw --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id"',
			'Generate ReScript and print only the code. Use this when you want the generated module directly.'
		);
}

function buildDaemonCommand(yargs: Argv) {
	return yargs
		.option('socket', {
			type: 'string',
			describe: 'Unix socket path for IPC. Defaults to `/tmp/typesql.sock`.'
		})
		.option('stdio', {
			type: 'boolean',
			default: false,
			describe: 'Serve NDJSON requests and responses on stdio instead of a Unix socket.'
		})
		.example(
			'$0 rescript daemon --stdio --config ./typesql.json',
			'Start the ReScript daemon on stdio. Use this for build tooling and long-lived editor integrations.'
		)
		.strict();
}

function buildCheckCommand(yargs: Argv) {
	return addSqlCommandOptions(yargs)
		.example(
			'$0 rescript check --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id"',
			'Validate the query, inspect its parameter metadata, and return the JSON Schema for accepted variables.'
		);
}

function buildInspectCommand(yargs: Argv) {
	return addVariableOptions(addSqlCommandOptions(yargs))
		.example(
			'$0 rescript inspect --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id"',
			'Show the raw and prepared SQL and report which variables are still required.'
		)
		.example(
			'$0 rescript inspect --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id" --vars \'{"id":1}\'',
			'Resolve the query to executable SQL and ordered bind values.'
		);
}

function buildExplainCommand(yargs: Argv) {
	return addVariableOptions(addSqlCommandOptions(yargs))
		.option('analyze', {
			type: 'boolean',
			default: false,
			describe: 'Request EXPLAIN ANALYZE where the dialect supports it. Use representative values for real perf work.'
		})
		.option('allow-side-effects', {
			type: 'boolean',
			default: false,
			describe: 'Required when using --analyze on mutating queries, because ANALYZE can execute the statement.'
		})
		.example(
			'$0 rescript explain --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id" --vars \'{"id":1}\'',
			'Get a query plan for a resolved embedded query.'
		)
		.example(
			'$0 rescript explain --analyze --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id" --vars \'{"id":1}\'',
			'Run EXPLAIN ANALYZE when supported. Use this only with representative variables.'
		);
}

function buildExecCommand(yargs: Argv) {
	return addVariableOptions(addSqlCommandOptions(yargs)).example(
		'$0 rescript exec --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id" --vars \'{"id":1}\'',
		'Execute the embedded query with explicit variables and return rows or write-result metadata.'
	);
}

async function handleGenerateCommand(args: GenerateArgs) {
	loadEnvFileIfPresent(args.envFile);
	try {
		const sql = await readRequiredSql(args.sql);
		await withRescriptContext(args.config, async ({ dbClient, schemaInfo }) => {
			const { rescript, originalTs } = await generateReScriptWithClient(dbClient, schemaInfo, args.name, sql);
			if (args.raw) {
				process.stdout.write(rescript + '\n');
				return;
			}
			writeJsonOutput(buildGenerateResponse(args.name, dbClient.type, sql, rescript, originalTs));
		});
	} catch (error: unknown) {
		if (args.raw) {
			console.error(`Error: ${errorMessage(error)}.`);
		} else {
			writeJsonOutput(buildErrorResponse('generate', inferErrorCode(error), errorMessage(error)));
		}
		process.exitCode = 1;
	}
}

async function handleDaemonCommand(args: DaemonArgs) {
	loadEnvFileIfPresent(args.envFile);
	try {
		const context = await openRescriptContext(args.config);
		if (args.stdio) {
			startStdioDaemon(context.dbClient, context.schemaInfo, context.close);
			return;
		}
		startSocketDaemon(args.socket || '/tmp/typesql.sock', context.dbClient, context.schemaInfo, context.close);
	} catch (error: unknown) {
		console.error(`Error: ${errorMessage(error)}.`);
		process.exitCode = 1;
	}
}

async function handleCheckCommand(args: NamedSqlArgs) {
	await runJsonCommand('check', args, async (context) => {
		const { dbClient } = context;
		const sql = await readRequiredSql(args.sql);
		const check = await checkRescriptQuery(dbClient, context.schemaInfo, sql);
		return buildCheckResponse(args.name, dbClient.type, check);
	});
}

async function handleInspectCommand(args: VariableArgs) {
	await runJsonCommand('inspect', args, async (context) => {
		const { dbClient } = context;
		const resolved = await prepareResolvedQuery(args, context);
		return buildInspectResponse(args.name, dbClient.type, resolved);
	});
}

async function handleExplainCommand(args: ExplainArgs) {
	await runJsonCommand('explain', args, async (context) => {
		const { dbClient } = context;
		const resolved = await prepareResolvedQuery(args, context);
		if (!resolved.resolved) {
			return buildMissingVariablesError('explain', args.name, resolved);
		}
		if (args.analyze && resolved.descriptor.queryType !== 'Select' && !args.allowSideEffects) {
			return buildErrorResponse(
				'explain',
				'ANALYZE_REQUIRES_ALLOW_SIDE_EFFECTS',
				'EXPLAIN ANALYZE may execute mutating queries. Re-run with --allow-side-effects to continue.'
			);
		}
		const plan = await explainRescriptQuery(dbClient, resolved, Boolean(args.analyze));
		return buildExplainResponse(args.name, dbClient.type, resolved, Boolean(args.analyze), plan);
	});
}

async function handleExecCommand(args: VariableArgs) {
	await runJsonCommand('exec', args, async (context) => {
		const { dbClient } = context;
		const resolved = await prepareResolvedQuery(args, context);
		if (!resolved.resolved) {
			return buildMissingVariablesError('exec', args.name, resolved);
		}
		const result = await execRescriptQuery(dbClient, resolved);
		return buildExecResponse(args.name, dbClient.type, resolved, result);
	});
}

async function handleGetEmbedCommand(args: BaseArgs) {
	loadEnvFileIfPresent(args.envFile);
	try {
		const inputText = await readAllStdin();
		const input = parseGetEmbedInput(parseJsonInput(inputText || '{}', 'stdin payload'));
		const sql = input.query;
		const queryName = input.id;
		if (!sql.trim()) {
			process.stdout.write(JSON.stringify({ status: 'error', errors: [{ message: 'No SQL provided in input.data' }] }));
			return;
		}
		await withRescriptContext(args.config, async ({ dbClient, schemaInfo }) => {
			const { rescript } = await generateReScriptWithClient(dbClient, schemaInfo, queryName, sql);
			process.stdout.write(JSON.stringify({ status: 'ok', code: rescript }));
		});
	} catch (error: unknown) {
		process.stdout.write(JSON.stringify({ status: 'error', errors: [{ message: errorMessage(error) }] }));
	}
}

async function runJsonCommand(
	command: ToolCommandName,
	args: BaseArgs,
	callback: (context: JsonCommandContext) => Promise<JsonCommandResponse>
) {
	loadEnvFileIfPresent(args.envFile);
	try {
		const response = await withRescriptContext(args.config, callback);
		writeJsonOutput(response);
		if (response.ok === false) {
			process.exitCode = 1;
		}
	} catch (error: unknown) {
		writeJsonOutput(buildErrorResponse(command, inferErrorCode(error), errorMessage(error)));
		process.exitCode = 1;
	}
}

async function readRequiredSql(value?: string) {
	const sql = await readStdinIfNeeded(value);
	if (!sql.trim()) {
		throw new Error('No SQL provided. Pass --sql or pipe SQL via stdin.');
	}
	return sql;
}

function readVariablesInput(args: Pick<VariableArgs, 'vars' | 'varsFile'>): unknown {
	if (args.vars && args.varsFile) {
		throw new Error('Pass either --vars or --vars-file, not both.');
	}
	if (args.varsFile) {
		return readJsonFile(args.varsFile, 'variables file');
	}
	if (args.vars) {
		return parseJsonInput(args.vars, 'variables');
	}
	return undefined;
}

async function prepareResolvedQuery(args: VariableArgs, context: JsonCommandContext) {
	const sql = await readRequiredSql(args.sql);
	const check = await checkRescriptQuery(context.dbClient, context.schemaInfo, sql);
	const variables = readVariablesInput(args);
	const baseResolved = inspectCheckedRescriptQuery(check, variables);
	return hydrateResolvedQuery(args, context, sql, baseResolved, variables);
}

async function hydrateResolvedQuery(
	args: VariableArgs,
	context: JsonCommandContext,
	sql: string,
	baseResolved: ResolvedQuery,
	variables: unknown
) {
	if (!baseResolved.resolved || baseResolved.executableSql != null) {
		return baseResolved;
	}
	const { originalTs } = await generateReScriptWithClient(context.dbClient, context.schemaInfo, args.name, sql);
	return resolveQueryWithGeneratedCode({
		queryName: args.name,
		originalTs,
		dialect: context.dbClient.type,
		descriptor: baseResolved.descriptor,
		variables,
		baseResolved
	});
}

function inferErrorCode(error: unknown): RescriptErrorCode {
	const message = errorMessage(error);
	if (message.includes('No SQL provided')) {
		return 'NO_SQL_PROVIDED';
	}
	if (message.includes('Invalid') || message.includes('Pass either --vars or --vars-file')) {
		return 'INVALID_INPUT';
	}
	return 'COMMAND_FAILED';
}

function getRescriptHelpText() {
	return `ReScript embedded SQL commands

Use these commands for SQL embedded through the ReScript integration. The debug commands are JSON-first so agents can inspect the query shape, variables, and responses without scraping text.

Commands:
  typesql rescript generate   Generate embedded ReScript code from SQL
  typesql rescript daemon     Start the long-lived ReScript daemon
  typesql rescript check      Validate SQL and describe the expected variables
  typesql rescript inspect    Show prepared SQL, final SQL, and bind values
  typesql rescript explain    Run EXPLAIN or EXPLAIN ANALYZE for a resolved query
  typesql rescript exec       Execute a resolved query with explicit variables

Use each command for:
  generate: create the embedded ReScript module for a query
  daemon: keep one database connection warm for tooling
  check: learn the variable shape before supplying values
  inspect: chase query-shape and binding issues
  explain: inspect plan shape and performance characteristics
  exec: run the query exactly as the embedded runtime would

Examples:
  typesql rescript generate --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id"
  typesql rescript check --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id"
  typesql rescript inspect --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id"
  typesql rescript inspect --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id" --vars '{"id":1}'
  typesql rescript explain --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id" --vars '{"id":1}'
  typesql rescript exec --config ./typesql.json --name selectUsers --sql "select id, name from users where id = :id" --vars '{"id":1}'

Compatibility aliases:
  typesql daemon
  typesql get-embed
`;
}

function parseBaseArgs(value: unknown): BaseArgs {
	const args = requireRecord(value, 'Invalid CLI arguments.');
	return {
		config: readOptionalString(args, 'config') ?? './typesql.json',
		envFile: readOptionalString(args, 'envFile')
	};
}

function parseNamedSqlArgs(value: unknown): NamedSqlArgs {
	const args = requireRecord(value, 'Invalid CLI arguments.');
	return {
		...parseBaseArgs(args),
		name: readRequiredString(args, 'name', 'Missing required --name option.'),
		sql: readOptionalString(args, 'sql')
	};
}

function parseGenerateArgs(value: unknown): GenerateArgs {
	const args = requireRecord(value, 'Invalid CLI arguments.');
	return {
		...parseNamedSqlArgs(args),
		raw: readBooleanFlag(args, 'raw')
	};
}

function parseVariableArgs(value: unknown): VariableArgs {
	const args = requireRecord(value, 'Invalid CLI arguments.');
	return {
		...parseNamedSqlArgs(args),
		vars: readOptionalString(args, 'vars'),
		varsFile: readOptionalString(args, 'varsFile')
	};
}

function parseExplainArgs(value: unknown): ExplainArgs {
	const args = requireRecord(value, 'Invalid CLI arguments.');
	return {
		...parseVariableArgs(args),
		analyze: readBooleanFlag(args, 'analyze'),
		allowSideEffects: readBooleanFlag(args, 'allowSideEffects')
	};
}

function parseDaemonArgs(value: unknown): DaemonArgs {
	const args = requireRecord(value, 'Invalid CLI arguments.');
	return {
		...parseBaseArgs(args),
		stdio: readBooleanFlag(args, 'stdio'),
		socket: readOptionalString(args, 'socket')
	};
}

function parseGetEmbedInput(input: unknown): GetEmbedInput {
	if (!isRecord(input)) {
		return { query: '', id: 'query' };
	}
	const rawData = isRecord(input.data)
		? input.data
		: {
				query: input.data,
				id: input.id
			};
	return {
		query: typeof rawData.query === 'string' ? rawData.query : String(rawData.query || ''),
		id: typeof rawData.id === 'string' ? rawData.id : String(rawData.id ?? 'query')
	};
}
