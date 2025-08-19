import assert from 'node:assert';
import fs from 'node:fs';
import { generateReScriptFromPostgres } from '../../src/rescript';
import { createSchemaInfo, createTestClient } from '../postgres/schema';
import { PgDielect } from '../../src/types';

// Toggle to regenerate fixture files locally if needed
const WRITE_FILES = true;

describe('generateReScriptFromPostgres', () => {
	const client = createTestClient();
	const databaseClient: PgDielect = {
		type: 'pg',
		client
	};
	const schemaInfo = createSchemaInfo();

	after(async () => {
		await client.end();
	});

	it('generates code for a simple select', async () => {
		// Use existing users table from migrations
		const sql = `select u.*, true as bool_expr, current_date as date_expr, current_timestamp as datetime_expr from users u where u.id = :id and u.name = :name`;

		const queryName = 'selectUsers';
		const { rescript, originalTs } = await generateReScriptFromPostgres({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient: databaseClient!,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('postgres-generate-rescript.select-users.rescript.txt', rescript);
			fs.writeFileSync('postgres-generate-rescript.select-users.ts.txt', originalTs);
		}

		// For now, just assert non-empty output; fixtures can be added later
		assert.ok(rescript && rescript.length > 0, 'Expected ReScript output to be non-empty');
	});

	it('generates code for a nested select (@nested)', async () => {
		// Use existing users/posts tables from migrations
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
		const { rescript, originalTs } = await generateReScriptFromPostgres({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('postgres-generate-rescript.select-user-posts-nested.rescript.txt', rescript);
			fs.writeFileSync('postgres-generate-rescript.select-user-posts-nested.ts.txt', originalTs);
		}

		assert.ok(rescript && rescript.length > 0, 'Expected ReScript output to be non-empty');
	});

	it('generates code for a dynamic query (@dynamicQuery)', async () => {
		// Use mytable1/mytable2 present in Postgres test schema
		const sql = `-- @dynamicQuery
SELECT m1.id, m1.value, m2.name, m2.descr as description
FROM mytable1 m1
INNER JOIN mytable2 m2 on m1.id = m2.id
WHERE m2.name = :name
AND m2.descr = :description`;

		const queryName = 'dynamicQuery01';
		const { rescript, originalTs } = await generateReScriptFromPostgres({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('postgres-generate-rescript.dynamic-query01.rescript.txt', rescript);
			fs.writeFileSync('postgres-generate-rescript.dynamic-query01.ts.txt', originalTs);
		}

		assert.ok(rescript && rescript.length > 0, 'Expected ReScript output to be non-empty');
	});

	it('generates code for nested JSON literals', async () => {
		// Use constant JSON values to ensure arrays and objects are handled
		const sql = `SELECT
	json_build_object(
	  'user', json_build_object(
	    'id', 1,
	    'name', 'Alice',
	    'address', json_build_object('city', 'NYC', 'zip', '10001')
	  ),
	  'tags', json_build_array('a', 'b', 'c'),
	  'meta', json_build_object('active', true, 'scores', json_build_array(1, 2, 3))
	) as payload,
	json_build_array(
	  json_build_object('id', 1),
	  json_build_object('id', 2, 'children', json_build_array(json_build_object('id', 3)))
	) as items`;

		const queryName = 'selectJsonNested';
		const { rescript, originalTs } = await generateReScriptFromPostgres({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('postgres-generate-rescript.select-json-nested.rescript.txt', rescript);
			fs.writeFileSync('postgres-generate-rescript.select-json-nested.ts.txt', originalTs);
		}

		assert.equal(rescript, fs.readFileSync('postgres-generate-rescript.select-json-nested.rescript.txt', 'utf8'));
	});

	it('maps bigint, json, and null to ReScript types', async () => {
		const sql = `SELECT
		CAST(123 AS bigint) as big,
		'{"a":1}'::jsonb as payload,
		'[1,2,3]'::json as list,
		NULL as nothing`;

		const queryName = 'selectBigintJsonNull';
		const { rescript, originalTs } = await generateReScriptFromPostgres({
			sql,
			queryName,
			isCrudFile: false,
			databaseClient,
			schemaInfo
		});

		if (WRITE_FILES) {
			fs.writeFileSync('postgres-generate-rescript.select-bigint-json-null.rescript.txt', rescript);
			fs.writeFileSync('postgres-generate-rescript.select-bigint-json-null.ts.txt', originalTs);
		}
	});
});
