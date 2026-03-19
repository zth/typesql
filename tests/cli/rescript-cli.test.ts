import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { createMysqlClientForTest } from '../../src/queryExectutor';

const CLI_PATH = path.resolve(process.cwd(), 'dist/src/cli.js');
const TEST_TIMEOUT_MS = 10000;
const POSTGRES_TEST_URI = 'postgres://postgres:password@127.0.0.1:5432/postgres';
const MYSQL_TEST_URI = 'mysql://root:password@localhost/mydb';

type CliResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

type CliFixture = {
	configPath: string;
	envFilePath?: string;
	sqlDir: string;
	tmpDir: string;
};

type PostgresCliFixture = {
	configPath: string;
	sqlDir: string;
	tmpDir: string;
	schemaName: string;
	cleanup: () => Promise<void>;
};

type MySqlCliFixture = {
	configPath: string;
	sqlDir: string;
	tmpDir: string;
	tableName: string;
	cleanup: () => Promise<void>;
};

describe('ReScript CLI commands', function () {
	this.timeout(TEST_TIMEOUT_MS);

	it('compile still generates TypeScript for sqlite configs', async () => {
		const fixture = createCliFixture();
		try {
			fs.writeFileSync(path.join(fixture.sqlDir, 'select-user.sql'), 'select id, name from users where id = :id');

			const result = await runCli(['compile', '--config', fixture.configPath]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const generated = fs.readFileSync(path.join(fixture.sqlDir, 'select-user.ts'), 'utf8');
			assert.match(generated, /export function selectUser/);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript generate returns a JSON envelope with generated code', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'generate',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsers',
				'--sql',
				'select id, name from users where id = :id'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: { rescript?: string };
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'generate');
			assert.match(payload.data?.rescript || '', /let query = run/);
			assert.match(payload.data?.rescript || '', /let default = query/);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript check returns variable schema metadata', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'check',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsers',
				'--sql',
				'select id, name from users where id = :id'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: {
					variablesSchema?: { properties?: Record<string, unknown>; required?: string[] };
					exampleVariables?: Record<string, unknown>;
				};
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'check');
			assert.deepStrictEqual(payload.data?.exampleVariables, { id: 1 });
			assert.deepStrictEqual(payload.data?.variablesSchema?.required, ['id']);
			assert.ok(payload.data?.variablesSchema?.properties?.id);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript inspect reports missing variables when they are not supplied', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'inspect',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsers',
				'--sql',
				'select id, name from users where id = :id'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: { resolved?: boolean; missingVariables?: string[] };
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'inspect');
			assert.strictEqual(payload.data?.resolved, false);
			assert.deepStrictEqual(payload.data?.missingVariables, ['id']);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript inspect resolves executable SQL and bind values when variables are supplied', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'inspect',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsers',
				'--sql',
				'select id, name from users where id = :id',
				'--vars',
				'{"id":1}'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: { resolved?: boolean; executableSql?: string; bindValues?: unknown[] };
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'inspect');
			assert.strictEqual(payload.data?.resolved, true);
			assert.match(payload.data?.executableSql || '', /where id = \?/i);
			assert.deepStrictEqual(payload.data?.bindValues, [1]);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript inspect resolves dynamic queries through generated query code', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'inspect',
				'--config',
				fixture.configPath,
				'--name',
				'dynamicUsers',
				'--sql=-- @dynamicQuery\nselect id, name from users',
				'--vars',
				'{"select":{"id":true},"where":[{"column":"id","op":"=","value":1}]}'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: {
					resolved?: boolean;
					descriptor?: { kind?: string };
					executableSql?: string;
					bindValues?: unknown[];
				};
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'inspect');
			assert.strictEqual(payload.data?.descriptor?.kind, 'dynamic');
			assert.strictEqual(payload.data?.resolved, true);
			assert.match(payload.data?.executableSql || '', /where id = \?/i);
			assert.deepStrictEqual(payload.data?.bindValues, [1]);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript inspect resolves update queries with separate data and params objects', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'inspect',
				'--config',
				fixture.configPath,
				'--name',
				'updateUserName',
				'--sql',
				'update users set name = :name where id = :id',
				'--vars',
				'{"data":{"name":"Grace"},"params":{"id":1}}'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: { resolved?: boolean; executableSql?: string; bindValues?: unknown[] };
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'inspect');
			assert.strictEqual(payload.data?.resolved, true);
			assert.match(payload.data?.executableSql || '', /update users set name = \? where id = \?/i);
			assert.deepStrictEqual(payload.data?.bindValues, ['Grace', 1]);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript explain returns a sqlite query plan', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'explain',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsers',
				'--sql',
				'select id, name from users where id = :id',
				'--vars',
				'{"id":1}'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: { plan?: unknown[]; executableSql?: string };
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'explain');
			assert.match(payload.data?.executableSql || '', /where id = \?/i);
			assert.ok(Array.isArray(payload.data?.plan));
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript explain --analyze succeeds for postgres select queries', async () => {
		const fixture = await createPostgresCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'explain',
				'--analyze',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsersPg',
				'--sql',
				`select id, name from ${fixture.schemaName}.users where id = :id`,
				'--vars',
				'{"id":1}'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: {
					analyze?: boolean;
					executableSql?: string;
					bindValues?: unknown[];
					plan?: Array<Record<string, unknown>>;
				};
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'explain');
			assert.strictEqual(payload.data?.analyze, true);
			assert.match(payload.data?.executableSql || '', /where id = \$1/i);
			assert.deepStrictEqual(payload.data?.bindValues, [1]);
			assert.ok(Array.isArray(payload.data?.plan));
			assert.ok(Array.isArray(payload.data?.plan?.[0]?.['QUERY PLAN']));
		} finally {
			await fixture.cleanup();
		}
	});

	it('rescript explain --analyze succeeds for mysql select queries', async () => {
		const fixture = await createMySqlCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'explain',
				'--analyze',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsersMysql',
				'--sql',
				`select id, name from ${fixture.tableName} where id = :id`,
				'--vars',
				'{"id":1}'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: {
					analyze?: boolean;
					executableSql?: string;
					bindValues?: unknown[];
					plan?: Array<Record<string, unknown>>;
				};
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'explain');
			assert.strictEqual(payload.data?.analyze, true);
			assert.match(payload.data?.executableSql || '', /where id = \?/i);
			assert.deepStrictEqual(payload.data?.bindValues, [1]);
			assert.ok(Array.isArray(payload.data?.plan));
			assert.ok((payload.data?.plan?.length || 0) > 0);
		} finally {
			await fixture.cleanup();
		}
	});

	it('rescript exec executes the query with explicit variables', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'exec',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsers',
				'--sql',
				'select id, name from users where id = :id',
				'--vars',
				'{"id":1}'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				data?: { rows?: Array<{ id: number; name: string }> };
			};
			assert.strictEqual(payload.ok, true);
			assert.strictEqual(payload.command, 'exec');
			assert.deepStrictEqual(payload.data?.rows, [{ id: 1, name: 'Ada' }]);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript exec returns a structured missing-variables error when required vars are absent', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'exec',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsers',
				'--sql',
				'select id, name from users where id = :id'
			]);

			assert.strictEqual(result.code, 1, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				error?: { code?: string; details?: { missingVariables?: string[] } };
			};
			assert.strictEqual(payload.ok, false);
			assert.strictEqual(payload.command, 'exec');
			assert.strictEqual(payload.error?.code, 'MISSING_VARIABLES');
			assert.deepStrictEqual(payload.error?.details?.missingVariables, ['id']);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript explain --analyze requires explicit side-effect opt-in for mutating queries', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'explain',
				'--analyze',
				'--config',
				fixture.configPath,
				'--name',
				'updateUserName',
				'--sql',
				'update users set name = :name where id = :id',
				'--vars',
				'{"data":{"name":"Grace"},"params":{"id":1}}'
			]);

			assert.strictEqual(result.code, 1, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				command: string;
				error?: { code?: string; message?: string };
			};
			assert.strictEqual(payload.ok, false);
			assert.strictEqual(payload.command, 'explain');
			assert.strictEqual(payload.error?.code, 'ANALYZE_REQUIRES_ALLOW_SIDE_EFFECTS');
			assert.match(payload.error?.message || '', /allow-side-effects/i);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('get-embed returns structured JSON', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli(
				['get-embed', '--config', fixture.configPath],
				JSON.stringify({
					data: {
						query: 'select id, name from users where id = :id',
						id: 'selectUsers'
					}
				})
			);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as { status: string; code?: string };
			assert.strictEqual(payload.status, 'ok');
			assert.match(payload.code || '', /let query = run/);
			assert.match(payload.code || '', /let default = query/);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('get-embed honors --env-file when config uses environment variables', async () => {
		const fixture = createCliFixture({ useEnvVarForDatabaseUri: true });
		try {
			const result = await runCli(
				['get-embed', '--config', fixture.configPath, '--env-file', fixture.envFilePath as string],
				JSON.stringify({
					data: {
						query: 'select id, name from users where id = :id',
						id: 'selectUsers'
					}
				})
			);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);

			const payload = JSON.parse(result.stdout.trim()) as { status: string; code?: string };
			assert.strictEqual(payload.status, 'ok');
			assert.match(payload.code || '', /let query = run/);
			assert.match(payload.code || '', /let default = query/);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('rescript daemon --stdio speaks pure NDJSON and supports shutdown', async () => {
		const fixture = createCliFixture();
		const child = spawnCli(['rescript', 'daemon', '--stdio', '--config', fixture.configPath]);
		try {
			const nextStdoutLine = createLineReader(child.stdout);

			child.stdin.write(
				JSON.stringify({
					action: 'rescript',
					name: 'selectUsers',
					sql: 'select id, name from users where id = :id'
				}) + '\n'
			);

			const rescriptResponse = JSON.parse(await nextStdoutLine()) as {
				ok: boolean;
				action: string;
				rescript?: string;
			};
			assert.strictEqual(rescriptResponse.ok, true);
			assert.strictEqual(rescriptResponse.action, 'rescript');
			assert.match(rescriptResponse.rescript || '', /let query = run/);
			assert.match(rescriptResponse.rescript || '', /let default = query/);

			child.stdin.write(JSON.stringify({ action: 'shutdown' }) + '\n');

			const shutdownResponse = JSON.parse(await nextStdoutLine()) as {
				ok: boolean;
				action: string;
			};
			assert.deepStrictEqual(shutdownResponse, { ok: true, action: 'shutdown' });

			const exitResult = await waitForExit(child, TEST_TIMEOUT_MS);
			assert.strictEqual(exitResult.code, 0, exitResult.stderr);
			assert.strictEqual(exitResult.signal, null);
		} finally {
			if (!child.killed) {
				child.kill('SIGKILL');
			}
			cleanupFixture(fixture);
		}
	});

	it('top-level daemon remains as a compatibility alias', async () => {
		const fixture = createCliFixture();
		const child = spawnCli(['daemon', '--stdio', '--config', fixture.configPath]);
		try {
			const nextStdoutLine = createLineReader(child.stdout);

			child.stdin.write(
				JSON.stringify({
					action: 'rescript',
					name: 'selectUsers',
					sql: 'select id, name from users where id = :id'
				}) + '\n'
			);

			const response = JSON.parse(await nextStdoutLine()) as {
				ok: boolean;
				action: string;
				rescript?: string;
			};
			assert.strictEqual(response.ok, true);
			assert.strictEqual(response.action, 'rescript');
			assert.match(response.rescript || '', /let query = run/);
			assert.match(response.rescript || '', /let default = query/);

			child.stdin.write(JSON.stringify({ action: 'shutdown' }) + '\n');
			const shutdown = JSON.parse(await nextStdoutLine()) as { ok: boolean; action: string };
			assert.deepStrictEqual(shutdown, { ok: true, action: 'shutdown' });

			const exitResult = await waitForExit(child, TEST_TIMEOUT_MS);
			assert.strictEqual(exitResult.code, 0, exitResult.stderr);
			assert.strictEqual(exitResult.signal, null);
		} finally {
			if (!child.killed) {
				child.kill('SIGKILL');
			}
			cleanupFixture(fixture);
		}
	});
});

function createCliFixture(options?: { useEnvVarForDatabaseUri?: boolean }): CliFixture {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typesql-cli-'));
	const sqlDir = path.join(tmpDir, 'sql');
	fs.mkdirSync(sqlDir, { recursive: true });

	const dbPath = path.join(tmpDir, 'test.db');
	const db = new Database(dbPath);
	db.exec(`
		create table users (
			id integer primary key,
			name text not null
		);
		insert into users (name) values ('Ada');
	`);
	db.close();

	const configPath = path.join(tmpDir, 'typesql.json');
	const envFilePath = path.join(tmpDir, '.env');
	const databaseUri = options?.useEnvVarForDatabaseUri ? '${TEST_TYPESQL_DB_PATH}' : dbPath;
	if (options?.useEnvVarForDatabaseUri) {
		fs.writeFileSync(envFilePath, `TEST_TYPESQL_DB_PATH=${dbPath}\n`);
	}
	fs.writeFileSync(
		configPath,
		JSON.stringify(
			{
				databaseUri,
				sqlDir,
				client: 'better-sqlite3',
				includeCrudTables: []
			},
			null,
			2
		)
	);

	return {
		configPath,
		envFilePath: options?.useEnvVarForDatabaseUri ? envFilePath : undefined,
		sqlDir,
		tmpDir
	};
}

async function createPostgresCliFixture(): Promise<PostgresCliFixture> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typesql-cli-pg-'));
	const sqlDir = path.join(tmpDir, 'sql');
	fs.mkdirSync(sqlDir, { recursive: true });

	const schemaName = `typesql_cli_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
	const sql = postgres(POSTGRES_TEST_URI);
	await sql.unsafe(`create schema ${schemaName}`);
	await sql.unsafe(`
		create table ${schemaName}.users (
			id integer primary key,
			name text not null
		)
	`);
	await sql.unsafe(`insert into ${schemaName}.users (id, name) values (1, 'Ada')`);

	const configPath = path.join(tmpDir, 'typesql.json');
	fs.writeFileSync(
		configPath,
		JSON.stringify(
			{
				databaseUri: POSTGRES_TEST_URI,
				sqlDir,
				client: 'pg',
				schemas: [schemaName],
				includeCrudTables: []
			},
			null,
			2
		)
	);

	return {
		configPath,
		sqlDir,
		tmpDir,
		schemaName,
		cleanup: async () => {
			try {
				await sql.unsafe(`drop table if exists ${schemaName}.users`);
				await sql.unsafe(`drop schema if exists ${schemaName}`);
			} finally {
				await sql.end();
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		}
	};
}

async function createMySqlCliFixture(): Promise<MySqlCliFixture> {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typesql-cli-mysql-'));
	const sqlDir = path.join(tmpDir, 'sql');
	fs.mkdirSync(sqlDir, { recursive: true });

	const tableName = `typesql_cli_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
	const databaseClient = await createMysqlClientForTest(MYSQL_TEST_URI);
	await databaseClient.client.query(`
		create table ${tableName} (
			id integer primary key,
			name varchar(255) not null
		)
	`);
	await databaseClient.client.query(`insert into ${tableName} (id, name) values (?, ?)`, [1, 'Ada']);

	const configPath = path.join(tmpDir, 'typesql.json');
	fs.writeFileSync(
		configPath,
		JSON.stringify(
			{
				databaseUri: MYSQL_TEST_URI,
				sqlDir,
				client: 'mysql2',
				includeCrudTables: []
			},
			null,
			2
		)
	);

	return {
		configPath,
		sqlDir,
		tmpDir,
		tableName,
		cleanup: async () => {
			try {
				await databaseClient.client.query(`drop table if exists ${tableName}`);
			} finally {
				await databaseClient.client.end();
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		}
	};
}

function cleanupFixture(fixture: CliFixture) {
	fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

function spawnCli(args: string[]) {
	return spawn(process.execPath, [CLI_PATH, ...args], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe']
	});
}

async function runCli(args: string[], stdin?: string): Promise<CliResult> {
	const child = spawnCli(args);
	const exitPromise = waitForExit(child, TEST_TIMEOUT_MS);
	if (stdin != null) {
		child.stdin.end(stdin);
	} else {
		child.stdin.end();
	}
	return exitPromise;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let finished = false;

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');

		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('close', (code, signal) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});

		const timer = setTimeout(() => {
			if (finished) return;
			finished = true;
			child.kill('SIGKILL');
			reject(new Error(`CLI process timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
}

function createLineReader(stream: NodeJS.ReadableStream) {
	let buffer = '';
	const pending: string[] = [];
	const waiters: Array<(line: string) => void> = [];

	stream.setEncoding('utf8');
	stream.on('data', (chunk: string) => {
		buffer += chunk;
		let newlineIndex = buffer.indexOf('\n');
		while (newlineIndex >= 0) {
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (waiters.length > 0) {
				const resolve = waiters.shift();
				resolve?.(line);
			} else {
				pending.push(line);
			}
			newlineIndex = buffer.indexOf('\n');
		}
	});

	return async function nextLine() {
		if (pending.length > 0) {
			return pending.shift() as string;
		}
		return new Promise<string>((resolve) => {
			waiters.push(resolve);
		});
	};
}
