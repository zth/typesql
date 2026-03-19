import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import postgres from 'postgres';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const MYSQL_HOST = process.env.TYPESQL_MYSQL_HOST ?? '127.0.0.1';
const MYSQL_PORT = Number(process.env.TYPESQL_MYSQL_PORT ?? '3306');
const MYSQL_USER = process.env.TYPESQL_MYSQL_USER ?? 'root';
const MYSQL_PASSWORD = process.env.TYPESQL_MYSQL_PASSWORD ?? 'password';
const MYSQL_DATABASE = process.env.TYPESQL_MYSQL_DATABASE ?? 'mydb';

const POSTGRES_URL = process.env.TYPESQL_POSTGRES_URL ?? 'postgres://postgres:password@127.0.0.1:5432/postgres';

async function main() {
	await Promise.all([setupMySql(), setupPostgres()]);
	console.log('[setup-test-databases] relational fixtures are ready');
}

async function setupMySql() {
	const connection = await waitForService('mysql', () =>
		mysql.createConnection({
			host: MYSQL_HOST,
			port: MYSQL_PORT,
			user: MYSQL_USER,
			password: MYSQL_PASSWORD,
			multipleStatements: true
		})
	);

	try {
		console.log(`[setup-test-databases] resetting MySQL database ${MYSQL_DATABASE}`);
		await connection.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\`; CREATE DATABASE \`${MYSQL_DATABASE}\`; USE \`${MYSQL_DATABASE}\`;`);

		for (const filePath of await listMigrationFiles(path.join(repoRoot, 'dbschema'))) {
			const sql = await fs.readFile(filePath, 'utf8');
			if (sql.trim() === '') {
				continue;
			}
			console.log(`[setup-test-databases] applying MySQL migration ${path.basename(filePath)}`);
			await connection.query(sql);
		}
	} finally {
		await connection.end();
	}
}

async function setupPostgres() {
	const sql = await waitForService('postgres', async () => {
		const client = postgres(POSTGRES_URL, { max: 1 });
		await client`select 1`;
		return client;
	});

	try {
		console.log('[setup-test-databases] resetting PostgreSQL schemas');
		const schemas = await sql.unsafe(`
			SELECT schema_name
			FROM information_schema.schemata
			WHERE schema_name <> 'information_schema'
				AND schema_name NOT LIKE 'pg_%'
		`);

		for (const row of schemas) {
			const schemaName = escapePostgresIdentifier(row.schema_name);
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
		}

		await sql.unsafe(`
			CREATE SCHEMA public;
			GRANT ALL ON SCHEMA public TO postgres;
			GRANT ALL ON SCHEMA public TO public;
		`);

		for (const filePath of await listMigrationFiles(path.join(repoRoot, 'migrations', 'postgres'))) {
			const migration = await fs.readFile(filePath, 'utf8');
			if (migration.trim() === '') {
				continue;
			}
			console.log(`[setup-test-databases] applying PostgreSQL migration ${path.basename(filePath)}`);
			await sql.unsafe(migration);
		}
	} finally {
		await sql.end();
	}
}

async function listMigrationFiles(dir) {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
		.map((entry) => path.join(dir, entry.name))
		.sort(compareMigrationPaths);
}

function compareMigrationPaths(left, right) {
	return compareMigrationNames(path.basename(left), path.basename(right));
}

function compareMigrationNames(left, right) {
	const leftVersion = readMigrationVersion(left);
	const rightVersion = readMigrationVersion(right);
	return leftVersion - rightVersion || left.localeCompare(right);
}

function readMigrationVersion(fileName) {
	const match = /^V(\d+)__/.exec(fileName);
	return match == null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

async function waitForService(name, createConnection, attempts = 30, delayMs = 2000) {
	let lastError = null;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await createConnection();
		} catch (error) {
			lastError = error;
			console.log(
				`[setup-test-databases] waiting for ${name} (${attempt}/${attempts}): ${formatError(error)}`
			);
			await sleep(delayMs);
		}
	}

	throw new Error(`[setup-test-databases] failed to connect to ${name}: ${formatError(lastError)}`);
}

function formatError(error) {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function escapePostgresIdentifier(value) {
	return String(value).replaceAll('"', '""');
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
