import assert from 'node:assert';
import { isLeft } from 'fp-ts/lib/Either';
import { explainSql } from '../src/sqlite-query-analyzer/query-executor';
import { openTestSqliteDb } from './fixture-paths';

describe('query-executor tests', () => {
	it('explain query with datetime parameter', async () => {
		const sql = `
        SELECT * FROM all_types where datetime_column = ?
        `;
		const db = openTestSqliteDb();
		const actual = await explainSql(db, sql);

		if (isLeft(actual)) {
			assert.fail(`Shouldn't return an error: ${actual.left.description}`);
		}
		assert.deepStrictEqual(actual.right, true);
	});
});
