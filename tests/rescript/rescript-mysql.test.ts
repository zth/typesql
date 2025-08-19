import assert from 'node:assert';
import fs from 'node:fs';
import { generateReScriptFromMySQL } from '../../src/rescript';
import type { SchemaInfo } from '../../src/schema-info';
import { createMysqlClientForTest, loadMysqlSchema } from '../../src/queryExectutor';

// Toggle to regenerate fixture files locally if needed
const WRITE_FILES = true;

describe('generateReScriptFromMySQL', () => {
	let schemaInfo!: SchemaInfo;
	let databaseClient: import('../../src/types').MySqlDialect;

	before(async () => {
		databaseClient = await createMysqlClientForTest('mysql://root:password@localhost/mydb');
		const schemaRes = await loadMysqlSchema(databaseClient.client as any, databaseClient.schema);
		if (schemaRes.isErr()) {
			assert.fail(`Failed to load MySQL schema: ${schemaRes.error.description}`);
		}
		schemaInfo = {
			kind: 'mysql2',
			columns: schemaRes.value
		};
	});

	after(async () => {
		await databaseClient.client.end();
	});

	it('generates code for a simple select', async () => {
		// Use existing users table from MySQL test DB
		const sql = `select u.*, true as bool_expr, curdate() as date_expr, now() as datetime_expr
from users u
where u.id in (:ids)
  and u.name in (:names)`;

		const queryName = 'selectUsers';
		const { rescript, originalTs } = await generateReScriptFromMySQL({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('mysql-generate-rescript.select-users.rescript.txt', rescript);
			fs.writeFileSync('mysql-generate-rescript.select-users.ts.txt', originalTs);
		}

		assert.ok(rescript && rescript.length > 0, 'Expected ReScript output to be non-empty');
	});

	it('generates code for a nested select (@nested)', async () => {
		const sql = `-- @nested
SELECT
  users.id,
  users.name,
  posts.id,
  posts.title,
  posts.body
FROM users
INNER JOIN posts on posts.fk_user = users.id`;

		const queryName = 'selectUserPosts';
		const { rescript, originalTs } = await generateReScriptFromMySQL({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('mysql-generate-rescript.select-user-posts-nested.rescript.txt', rescript);
			fs.writeFileSync('mysql-generate-rescript.select-user-posts-nested.ts.txt', originalTs);
		}

		assert.ok(rescript && rescript.length > 0, 'Expected ReScript output to be non-empty');
	});

	it('generates code for a dynamic query (@dynamicQuery)', async () => {
		const sql = `-- @dynamicQuery
SELECT m1.id, m1.value, m2.name, m2.descr as description
FROM mytable1 m1
INNER JOIN mytable2 m2 on m1.id = m2.id
WHERE m2.name = :name
AND m2.descr = :description`;

		const queryName = 'dynamicQuery01';
		const { rescript, originalTs } = await generateReScriptFromMySQL({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('mysql-generate-rescript.dynamic-query01.rescript.txt', rescript);
			fs.writeFileSync('mysql-generate-rescript.dynamic-query01.ts.txt', originalTs);
		}

		assert.ok(rescript && rescript.length > 0, 'Expected ReScript output to be non-empty');
	});
});
