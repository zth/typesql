import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import Database from 'better-sqlite3';

const CLI_PATH = path.resolve(process.cwd(), 'dist/src/cli.js');
const TEST_TIMEOUT_MS = 10000;

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

describe('ReScript CLI commands', () => {
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

	it('rescript prints generated code and exits cleanly', async () => {
		const fixture = createCliFixture();
		try {
			const result = await runCli([
				'rescript',
				'--config',
				fixture.configPath,
				'--name',
				'selectUsers',
				'--sql',
				'select id, name from users where id = :id'
			]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);
			assert.match(result.stdout, /let run:/);
			assert.match(result.stdout, /let default = run/);
			assert.match(result.stdout, /let run:/);
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
			assert.match(payload.code || '', /let default = run/);
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
			assert.match(payload.code || '', /let default = run/);
		} finally {
			cleanupFixture(fixture);
		}
	});

	it('daemon --stdio speaks pure NDJSON and supports shutdown', async () => {
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

			const rescriptResponse = JSON.parse(await nextStdoutLine()) as {
				ok: boolean;
				action: string;
				rescript?: string;
			};
			assert.strictEqual(rescriptResponse.ok, true);
			assert.strictEqual(rescriptResponse.action, 'rescript');
			assert.match(rescriptResponse.rescript || '', /let default = run/);

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
