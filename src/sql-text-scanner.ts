export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

export function getSpecialTokenEnd(sql: string, index: number, dialect: SqlDialect): number | null {
	const current = sql[index];
	const next = sql[index + 1];

	if (current === '-' && next === '-') {
		return skipLineComment(sql, index + 2);
	}
	if (dialect === 'mysql' && current === '#') {
		return skipLineComment(sql, index + 1);
	}
	if (current === '/' && next === '*') {
		return skipBlockComment(sql, index + 2);
	}
	if (current === '\'') {
		return skipQuoted(sql, index + 1, '\'');
	}
	if (current === '"') {
		return skipQuoted(sql, index + 1, '"');
	}
	if ((dialect === 'mysql' || dialect === 'sqlite') && current === '`') {
		return skipQuoted(sql, index + 1, '`');
	}
	if (dialect === 'postgres' && current === '$') {
		const dollarQuotedEnd = skipDollarQuoted(sql, index);
		if (dollarQuotedEnd !== index) {
			return dollarQuotedEnd;
		}
	}
	return null;
}

export function findNextSubstantiveIndex(sql: string, start: number, dialect: SqlDialect): number {
	let index = start;
	while (index < sql.length) {
		const specialEnd = getSpecialTokenEnd(sql, index, dialect);
		if (specialEnd != null) {
			if (startsWithComment(sql, index, dialect)) {
				index = specialEnd;
				continue;
			}
			return index;
		}
		if (!isWhitespace(sql[index])) {
			return index;
		}
		index++;
	}
	return sql.length;
}

export function isWhitespace(char: string) {
	return /\s/.test(char);
}

export function isWordStart(char: string) {
	return /[A-Za-z_]/.test(char);
}

export function isWordPart(char: string) {
	return /[A-Za-z0-9_$]/.test(char);
}

export function isNamedParamStartChar(char: string | undefined) {
	return char != null && /[A-Za-z$_]/.test(char);
}

export function isNamedParamPartChar(char: string | undefined) {
	return char != null && /[A-Za-z0-9$_]/.test(char);
}

function startsWithComment(sql: string, index: number, dialect: SqlDialect) {
	return (sql[index] === '-' && sql[index + 1] === '-')
		|| (dialect === 'mysql' && sql[index] === '#')
		|| (sql[index] === '/' && sql[index + 1] === '*');
}

function skipLineComment(sql: string, index: number) {
	while (index < sql.length && sql[index] !== '\n') {
		index++;
	}
	return index;
}

function skipBlockComment(sql: string, index: number) {
	let depth = 1;
	while (index < sql.length - 1) {
		if (sql[index] === '/' && sql[index + 1] === '*') {
			depth++;
			index += 2;
			continue;
		}
		if (sql[index] === '*' && sql[index + 1] === '/') {
			depth--;
			index += 2;
			if (depth === 0) {
				return index;
			}
			continue;
		}
		index++;
	}
	return sql.length;
}

function skipQuoted(sql: string, index: number, quote: '\'' | '"' | '`') {
	while (index < sql.length) {
		if (sql[index] === quote) {
			if (sql[index + 1] === quote) {
				index += 2;
				continue;
			}
			return index + 1;
		}
		index++;
	}
	return sql.length;
}

function skipDollarQuoted(sql: string, index: number) {
	if (sql[index] !== '$') {
		return index;
	}
	let endOfTag = index + 1;
	if (sql[endOfTag] === '$') {
		const tag = '$$';
		const closingTagIndex = sql.indexOf(tag, endOfTag + 1);
		return closingTagIndex === -1 ? sql.length : closingTagIndex + tag.length;
	}
	if (!/[A-Za-z_]/.test(sql[endOfTag] || '')) {
		return index;
	}
	endOfTag++;
	while (endOfTag < sql.length && /[A-Za-z0-9_]/.test(sql[endOfTag])) {
		endOfTag++;
	}
	if (sql[endOfTag] !== '$') {
		return index;
	}
	const tag = sql.slice(index, endOfTag + 1);
	const closingTagIndex = sql.indexOf(tag, endOfTag + 1);
	if (closingTagIndex === -1) {
		return sql.length;
	}
	return closingTagIndex + tag.length;
}
