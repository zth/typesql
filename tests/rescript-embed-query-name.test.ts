import assert from 'node:assert';
import { resolveEmbeddedSourceDisplayPath } from '../src/rescript-embed/file-generator';
import { parseEmbeddedQueryName } from '../src/rescript-embed/query-name';

describe('parseEmbeddedQueryName', () => {
	it('reads @name from the first trimmed line', () => {
		const result = parseEmbeddedQueryName(`

  /* @name GetUser */
  select id, name from users where id = :id
`);

		assert.deepStrictEqual(result, {
			rawQueryName: 'GetUser',
			queryName: 'getUser'
		});
	});

	it('supports first-line -- @name comments', () => {
		const result = parseEmbeddedQueryName(`

  -- @name RenameUser
  update users set name = :name where id = :id
`);

		assert.deepStrictEqual(result, {
			rawQueryName: 'RenameUser',
			queryName: 'renameUser'
		});
	});

	it('ignores later @name-looking text inside SQL literals', () => {
		const result = parseEmbeddedQueryName(`
/* @name GetLiteral */
select '-- @name fake' as literalValue, '/* @name fake */' as otherLiteral
`);

		assert.deepStrictEqual(result, {
			rawQueryName: 'GetLiteral',
			queryName: 'getLiteral'
		});
	});

	it('requires @name on the first trimmed line', () => {
		assert.throws(
			() =>
				parseEmbeddedQueryName(`
select id from users
/* @name GetUser */
`),
			/missing a required `@name`/i
		);
	});
});

describe('resolveEmbeddedSourceDisplayPath', () => {
	it('returns a srcDir-relative path using forward slashes', () => {
		assert.strictEqual(
			resolveEmbeddedSourceDisplayPath('/project/src/admin/users/Queries.res', '/project/src'),
			'admin/users/Queries.res'
		);
	});
});
