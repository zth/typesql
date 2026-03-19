import assert from 'node:assert';
import { update03, Update03Result } from './sql';
import { openTestSqliteDb } from '../fixture-paths';

describe('sqlite-update', () => {
    const db = openTestSqliteDb();

    it('update03-returning *', async () => {

        const insertTx = db.transaction(() => {
            const actual = update03(db, { param1: 10 }, { param1: 1 });
            const expected: Update03Result = {
                id: 1,
                value: 10
            }
            assert.deepStrictEqual(actual, expected);
            throw new Error('Rollback this transaction');
        });

        try {
            insertTx();
        } catch (e) {
            if (e instanceof Error) {
                assert.strictEqual(e.message, 'Rollback this transaction');
            } else {
                throw e;
            }
        }
    })
});
