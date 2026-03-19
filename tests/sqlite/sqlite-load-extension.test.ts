import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { isLeft } from 'fp-ts/lib/Either';
import { createSqliteClient, explainSql } from '../../src/sqlite-query-analyzer/query-executor';
import { createLibSqlClient } from '../../src/drivers/libsql';
import { SchemaDef } from '../../src/types';
import { parseSql } from '../../src/sqlite-query-analyzer/parser';
import { sqliteDbSchema } from '../mysql-query-analyzer/create-schema';
import { resolveTestPath, TEST_SQLITE_DB_PATH } from '../fixture-paths';

function resolveUuidExtensionPath() {
	switch (process.platform) {
		case 'win32':
			return resolveTestPath('ext', 'uuid.dll');
		case 'darwin':
			return resolveTestPath('ext', 'uuid.dylib');
		default:
			return resolveTestPath('ext', 'uuid.so');
	}
}

const uuidExtensionPath = resolveUuidExtensionPath();
const maybeIt = fs.existsSync(uuidExtensionPath) ? it : it.skip;

describe('load-extension', () => {
	maybeIt('better-sqlite3 - load_extension uuid4', () => {

		const client = createSqliteClient('better-sqlite3', TEST_SQLITE_DB_PATH, [], [uuidExtensionPath]);
		if (client.isErr()) {
			assert.fail(`Shouldn't return an Error`);
		}

		const clientType = client.value.type;
		if (clientType != 'better-sqlite3') {
			assert.fail(`Shouldn't return an Error`);
		}
		const explainSqlResult = explainSql(client.value.client, 'SELECT uuid4()');

		if (isLeft(explainSqlResult)) {
			assert.fail(`Shouldn't return an Error`);
		}
		assert.deepStrictEqual(explainSqlResult.right, true);
	});

	maybeIt('bun:sqlite - load_extension uuid4', () => {

		const client = createSqliteClient('bun:sqlite', TEST_SQLITE_DB_PATH, [], [uuidExtensionPath]);
		if (client.isErr()) {
			assert.fail(`Shouldn't return an Error`);
		}

		const clientType = client.value.type;
		if (clientType != 'bun:sqlite') {
			assert.fail(`Shouldn't return an Error`);
		}
		const explainSqlResult = explainSql(client.value.client, 'SELECT uuid4()');

		if (isLeft(explainSqlResult)) {
			assert.fail(`Shouldn't return an Error`);
		}
		assert.deepStrictEqual(explainSqlResult.right, true);
	});

	maybeIt('libsql - load_extension uuid4', () => {

		const client = createLibSqlClient(TEST_SQLITE_DB_PATH, [], [uuidExtensionPath], 'authtoken');
		if (client.isErr()) {
			assert.fail(`Shouldn't return an Error`);
		}

		const clientType = client.value.type;
		if (clientType != 'libsql') {
			assert.fail(`Shouldn't return an Error`);
		}
		const explainSqlResult = explainSql(client.value.client, 'SELECT uuid4()');

		if (isLeft(explainSqlResult)) {
			assert.fail(`Shouldn't return an Error`);
		}
		assert.deepStrictEqual(explainSqlResult.right, true);
	});

	it('select uuid4() as uuid4, uuid7() as uuid7', () => {
		const sql = 'select uuid4() as uuid4, uuid7() as uuid7';

		const actual = parseSql(sql, sqliteDbSchema);
		const expected: SchemaDef = {
			sql,
			queryType: 'Select',
			multipleRowsResult: false,
			columns: [
				{
					name: 'uuid4',
					type: 'TEXT',
					notNull: true,
					table: ''
				},
				{
					name: 'uuid7',
					type: 'TEXT',
					notNull: true,
					table: ''
				}
			],
			parameters: []
		};

		if (isLeft(actual)) {
			assert.fail(`Shouldn't return an error: ${actual.left.description}`);
		}
		assert.deepStrictEqual(actual.right, expected);
	});
});
