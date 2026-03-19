import assert from 'node:assert';
import { countQuestionMarkParams, detectQueryType } from '../src/sql-query-type';

describe('sql-query-type', () => {
	describe('detectQueryType', () => {
		it('detects a simple select', () => {
			assert.strictEqual(detectQueryType('select * from mytable1'), 'Select');
		});

		it('detects the statement after leading comments', () => {
			const sql = `
-- leading comment with select ? text
/* block comment with insert into demo values (?) */
select * from mytable1`;
			assert.strictEqual(detectQueryType(sql), 'Select');
		});

		it('detects the outer statement after a CTE', () => {
			const sql = `
with seeded as (
	select '?', 'select', 1
)
insert into mytable1(value)
select 1 from seeded`;
			assert.strictEqual(detectQueryType(sql), 'Insert');
		});

		it('ignores keywords inside quoted identifiers and string literals', () => {
			const sql = `select "insert", 'delete', 'it''s a select' from mytable1`;
			assert.strictEqual(detectQueryType(sql), 'Select');
		});

		it('ignores keywords inside dollar-quoted strings', () => {
			const sql = `
select $tag$
insert into logs values ('not real sql')
$tag$, value
from mytable1`;
			assert.strictEqual(detectQueryType(sql), 'Select');
		});

		it('handles nested block comments', () => {
			const sql = `
/* outer
	/* inner select */
*/
delete from mytable1`;
			assert.strictEqual(detectQueryType(sql), 'Delete');
		});
	});

	describe('countQuestionMarkParams', () => {
		it('counts only real placeholders', () => {
			assert.strictEqual(countQuestionMarkParams('select * from mytable1 where id = ? and value = ?'), 2);
		});

		it('ignores question marks in comments and strings', () => {
			const sql = `
-- ? in line comment
/* ? in block comment */
select '?', "??", \`?\`
from mytable1
where id = ? and note = 'still ?'`;
			assert.strictEqual(countQuestionMarkParams(sql), 1);
		});

		it('ignores question marks in dollar-quoted strings', () => {
			const sql = `
select $fn$
	begin
		return '?';
	end
$fn$, ?
from mytable1`;
			assert.strictEqual(countQuestionMarkParams(sql), 1);
		});

		it('handles nested block comments while counting placeholders', () => {
			const sql = `
/* outer
	/* inner ? */
*/
select ? from mytable1`;
			assert.strictEqual(countQuestionMarkParams(sql), 1);
		});
	});
});
