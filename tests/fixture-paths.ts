import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const TEST_SQLITE_DB_PATH = path.join(REPO_ROOT, 'mydb.db');
export const TEST_USERS_DB_PATH = path.join(REPO_ROOT, 'users.db');
export const TESTS_ROOT = path.join(REPO_ROOT, 'tests');

export function openTestSqliteDb(): BetterSqlite3Database {
	assertFixtureFileExists(TEST_SQLITE_DB_PATH);
	return new Database(TEST_SQLITE_DB_PATH, { fileMustExist: true });
}

export function resolveTestPath(...segments: string[]) {
	return path.join(TESTS_ROOT, ...segments);
}

export function toSqliteStringLiteral(value: string) {
	return value.split("'").join("''");
}

function assertFixtureFileExists(filePath: string) {
	if (fs.existsSync(filePath)) {
		return;
	}

	throw new Error(
		`Missing SQLite test fixture at ${filePath}. Run \`npm run setup:sqlite-fixtures\` or \`npm run ci:setup-db\`.`
	);
}
