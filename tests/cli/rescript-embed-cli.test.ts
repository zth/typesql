import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import Database from 'better-sqlite3';

const CLI_PATH = path.resolve(process.cwd(), 'dist/src/cli.js');
const FIXTURE_TEMPLATE_DIR = path.resolve(process.cwd(), 'tests/fixtures/rescript-generated-typesql-project');
const TEST_TIMEOUT_MS = 30000;
type BetterSqlite3Database = InstanceType<typeof Database>;

type CliResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

type EmbedFixture = {
	tmpDir: string;
	configPath: string;
	sourcePath: string;
	generatedPath: string;
	dbPath: string;
};

describe('ReScript embedded sync/watch commands', function () {
	this.timeout(TEST_TIMEOUT_MS);

	it('rescript sync generates __typesql.res files in the configured outDir for %generated.typesql embeds', async () => {
		const fixture = createEmbedFixture(`
let getUser = %generated.typesql(\`
  /* @name GetUser */
  select id, name from users where id = :id
\`)

module RenameUser = %generated.typesql(\`
  /* @name RenameUser */
  update users set name = :name where id = :id
\`)
`);

		try {
			const result = await runCli(['rescript', 'sync', '--config', fixture.configPath]);

			assert.strictEqual(result.code, 0, result.stderr);
			assert.strictEqual(result.signal, null);
			assert.match(result.stdout, /generated=1/);
			assert.ok(fs.existsSync(fixture.generatedPath));

			const generated = fs.readFileSync(fixture.generatedPath, 'utf8');
			assert.match(generated, /module M1 = \{/);
			assert.match(generated, /module M2 = \{/);
			assert.doesNotMatch(generated, /module BetterSqlite3 = \{ type client \}/);
			assert.match(generated, /let query = run/);
			assert.match(generated, /let default = query/);
		} finally {
			cleanupFixture(fixture.tmpDir);
		}
	});

	it('rescript sync fails when an embedded query is missing @name', async () => {
		const fixture = createEmbedFixture(`
let getUser = %generated.typesql(\`
  select id, name from users where id = :id
\`)
`);

		try {
			const result = await runCli(['rescript', 'sync', '--config', fixture.configPath]);

			assert.strictEqual(result.code, 1, result.stderr);
			assert.strictEqual(result.signal, null);
			assert.match(result.stderr, /missing a required `@name`/i);
			assert.strictEqual(fs.existsSync(fixture.generatedPath), false);
		} finally {
			cleanupFixture(fixture.tmpDir);
		}
	});

	it('rescript sync removes stale generated files when a source becomes invalid', async () => {
		const fixture = createEmbedFixture(`
let getUser = %generated.typesql(\`
  /* @name GetUser */
  select id, name from users where id = :id
\`)
`);

		try {
			const initialResult = await runCli(['rescript', 'sync', '--config', fixture.configPath]);
			assert.strictEqual(initialResult.code, 0, initialResult.stderr);
			assert.ok(fs.existsSync(fixture.generatedPath));

			fs.writeFileSync(
				fixture.sourcePath,
				`
let getUser = %generated.typesql(\`
  select id, name from users where id = :id
\`)
`
			);

			const result = await runCli(['rescript', 'sync', '--config', fixture.configPath]);

			assert.strictEqual(result.code, 1, result.stderr);
			assert.match(result.stderr, /missing a required `@name`/i);
			assert.strictEqual(fs.existsSync(fixture.generatedPath), false);
		} finally {
			cleanupFixture(fixture.tmpDir);
		}
	});

	it('rescript sync fails when embedded query names collide after normalization', async () => {
		const fixture = createEmbedFixture(`
let getUser = %generated.typesql(\`
  /* @name GetUser */
  select id, name from users where id = :id
\`)

let getUserAgain = %generated.typesql(\`
  /* @name get-user */
  select id, name from users where id = :id
\`)
`);

		try {
			const result = await runCli(['rescript', 'sync', '--config', fixture.configPath]);

			assert.strictEqual(result.code, 1, result.stderr);
			assert.strictEqual(result.signal, null);
			assert.match(result.stderr, /duplicate embedded sql name/i);
			assert.strictEqual(fs.existsSync(fixture.generatedPath), false);
		} finally {
			cleanupFixture(fixture.tmpDir);
		}
	});

	it('rescript watch updates generated files when the source changes and removes them when the source is deleted', async () => {
		const fixture = createEmbedFixture(`
let getUser = %generated.typesql(\`
  /* @name GetUser */
  select id, name from users where id = :id
\`)
`);
		const child = spawnCli(['rescript', 'watch', '--config', fixture.configPath]);

		try {
			await waitForCondition(() => {
				assert.ok(fs.existsSync(fixture.generatedPath));
				const generated = fs.readFileSync(fixture.generatedPath, 'utf8');
				assert.match(generated, /module M1 = \{/);
			});

			fs.writeFileSync(
				fixture.sourcePath,
				`
let getUser = %generated.typesql(\`
  /* @name GetUser */
  select id, name from users where id = :id
\`)

module RenameUser = %generated.typesql(\`
  /* @name RenameUser */
  update users set name = :name where id = :id
\`)
`
			);

			await waitForCondition(() => {
				const generated = fs.readFileSync(fixture.generatedPath, 'utf8');
				assert.match(generated, /module M2 = \{/);
			});

			fs.rmSync(fixture.sourcePath);

			await waitForCondition(() => {
				assert.strictEqual(fs.existsSync(fixture.generatedPath), false);
			});
		} finally {
			if (!child.killed) {
				child.kill('SIGKILL');
			}
			await waitForExit(child, 5000);
			cleanupFixture(fixture.tmpDir);
		}
	});

	it('rescript watch removes stale generated files when a source becomes invalid', async () => {
		const fixture = createEmbedFixture(`
let getUser = %generated.typesql(\`
  /* @name GetUser */
  select id, name from users where id = :id
\`)
`);
		const child = spawnCli(['rescript', 'watch', '--config', fixture.configPath]);

		try {
			await waitForCondition(() => {
				assert.ok(fs.existsSync(fixture.generatedPath));
			});

			fs.writeFileSync(
				fixture.sourcePath,
				`
let getUser = %generated.typesql(\`
  select id, name from users where id = :id
\`)
`
			);

			await waitForCondition(() => {
				assert.strictEqual(fs.existsSync(fixture.generatedPath), false);
			});
		} finally {
			if (!child.killed) {
				child.kill('SIGKILL');
			}
			await waitForExit(child, 5000);
			cleanupFixture(fixture.tmpDir);
		}
	});
});

describe('ReScript embedded end-to-end fixture project', function () {
	this.timeout(TEST_TIMEOUT_MS);

	it('builds and runs a ReScript project that uses %generated.typesql via embed-lang', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typesql-rescript-project-'));
		copyFixtureTemplate(FIXTURE_TEMPLATE_DIR, tmpDir);

		try {
			const dbPath = path.join(tmpDir, 'test.db');
			const fixtureGeneratedPath = path.join(tmpDir, 'src', '__generated__', 'Queries__typesql.res');
			assert.ok(fs.existsSync(fixtureGeneratedPath), 'Expected the checked-in fixture to include Queries__typesql.res');

			const setupResult = await runCommand('npm', ['run', 'db:setup'], {
				cwd: tmpDir
			});
			assert.strictEqual(setupResult.code, 0, setupResult.stderr);

			const syncResult = await runCli(['rescript', 'sync', '--config', path.join(tmpDir, 'typesql.json')]);
			assert.strictEqual(syncResult.code, 0, syncResult.stderr);

			assert.ok(fs.existsSync(fixtureGeneratedPath));

			const buildResult = await runCommand('npm', ['run', 'build'], {
				cwd: tmpDir
			});
			assert.strictEqual(buildResult.code, 0, buildResult.stderr);

			const compiledQueryPath = path.join(tmpDir, 'lib', 'js', 'src', 'Queries.js');
			assert.ok(fs.existsSync(compiledQueryPath), 'Expected ReScript to compile Queries.res');

			const db = new Database(dbPath);
			try {
				delete require.cache[compiledQueryPath];
				const compiledModule = require(compiledQueryPath) as { run: (db: BetterSqlite3Database) => [unknown, unknown] };
				const [before, after] = compiledModule.run(db);
				assert.deepStrictEqual(before, { id: 1, name: 'Ada' });
				assert.deepStrictEqual(after, { id: 1, name: 'Grace' });
			} finally {
				db.close();
			}
		} finally {
			cleanupFixture(tmpDir);
		}
	});
});

function createEmbedFixture(sourceContents: string): EmbedFixture {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typesql-rescript-embed-'));
	const srcDir = path.join(tmpDir, 'src');
	const sqlDir = path.join(tmpDir, 'sql');
	fs.mkdirSync(srcDir, { recursive: true });
	fs.mkdirSync(sqlDir, { recursive: true });

	const dbPath = path.join(tmpDir, 'test.db');
	seedSqliteDatabase(dbPath);

	const sourcePath = path.join(srcDir, 'Queries.res');
	fs.writeFileSync(path.join(srcDir, 'BetterSqlite3.res'), 'type client\n');
	fs.writeFileSync(sourcePath, sourceContents.trimStart());
	const generatedDir = path.join(srcDir, '__generated__');

	const configPath = path.join(tmpDir, 'typesql.json');
	fs.writeFileSync(
		configPath,
		JSON.stringify(
			{
				databaseUri: dbPath,
				sqlDir,
					client: 'better-sqlite3',
					includeCrudTables: [],
					rescript: {
						srcDir,
						outDir: generatedDir
					}
				},
				null,
			2
		)
	);

	return {
		tmpDir,
		configPath,
		sourcePath,
		generatedPath: path.join(generatedDir, 'Queries__typesql.res'),
		dbPath
	};
}

function seedSqliteDatabase(dbPath: string) {
	const db = new Database(dbPath);
	try {
		db.exec(`
			create table users (
				id integer primary key,
				name text not null
			);
			insert into users (id, name) values (1, 'Ada');
		`);
	} finally {
		db.close();
	}
}

function copyFixtureTemplate(sourceDir: string, targetDir: string) {
	fs.cpSync(sourceDir, targetDir, {
		recursive: true
	});
	fs.symlinkSync(path.resolve(process.cwd(), 'node_modules'), path.join(targetDir, 'node_modules'), 'dir');
}

function cleanupFixture(tmpDir: string) {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

function spawnCli(args: string[]) {
	return spawn(process.execPath, [CLI_PATH, ...args], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe']
	});
}

async function runCli(args: string[], stdin?: string) {
	return runCommand(process.execPath, [CLI_PATH, ...args], {
		cwd: process.cwd(),
		stdin
	});
}

async function runCommand(
	command: string,
	args: string[],
	options: {
		cwd: string;
		stdin?: string;
	}
): Promise<CliResult> {
	const child = spawn(command, args, {
		cwd: options.cwd,
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const exitPromise = waitForExit(child, TEST_TIMEOUT_MS);

	if (options.stdin != null) {
		child.stdin.end(options.stdin);
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
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});

		const timer = setTimeout(() => {
			if (finished) {
				return;
			}
			finished = true;
			child.kill('SIGKILL');
			reject(new Error(`Process timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
}

async function waitForCondition(assertion: () => void, timeoutMs = TEST_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			assertion();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	assertion();
}
