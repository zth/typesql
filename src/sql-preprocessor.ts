import type { PreprocessedSql, NamedParamInfo } from './types';
import { findNextSubstantiveIndex, getSpecialTokenEnd, isNamedParamPartChar, isNamedParamStartChar, SqlDialect } from './sql-text-scanner';

export function preprocessSqlText(sql: string, dialect: SqlDialect): PreprocessedSql {
	const maxExistingParamNumber = dialect === 'postgres' ? findMaxExistingPostgresParamNumber(sql) : 0;
	let index = 0;
	let depth = 0;
	let newSql = '';
	let paramIndex = maxExistingParamNumber + 1;
	const paramMap: Record<string, number> = {};
	const namedParameters: NamedParamInfo[] = [];

	while (index < sql.length) {
		const specialEnd = getSpecialTokenEnd(sql, index, dialect);
		if (specialEnd != null) {
			newSql += sql.slice(index, specialEnd);
			index = specialEnd;
			continue;
		}

		const current = sql[index];
		if (current === '(') {
			depth++;
			newSql += current;
			index++;
			continue;
		}
		if (current === ')') {
			depth = Math.max(0, depth - 1);
			newSql += current;
			index++;
			continue;
		}
		if (current === ';' && depth === 0) {
			const nextIndex = findNextSubstantiveIndex(sql, index + 1, dialect);
			if (nextIndex < sql.length) {
				throw new Error('Multiple SQL statements are not supported');
			}
			newSql += current;
			index++;
			continue;
		}
		if (current === ':' && sql[index + 1] === ':') {
			newSql += '::';
			index += 2;
			continue;
		}
		if (current === ':' && isNamedParamStartChar(sql[index + 1])) {
			const end = readNamedParameterEnd(sql, index + 2);
			const paramName = sql.slice(index + 1, end);
			if (paramMap[paramName] == null) {
				paramMap[paramName] = paramIndex++;
			}
			namedParameters.push({ paramName, paramNumber: paramMap[paramName] });
			newSql += dialect === 'postgres' ? `$${paramMap[paramName]}` : '?';
			index = end;
			continue;
		}
		if (dialect === 'postgres' && current === '$' && /\d/.test(sql[index + 1] || '')) {
			const end = readPositionalParamEnd(sql, index + 1);
			const paramNumber = parseInt(sql.slice(index + 1, end), 10);
			namedParameters.push({
				paramName: `param${paramNumber}`,
				paramNumber
			});
			newSql += sql.slice(index, end);
			index = end;
			continue;
		}

		newSql += current;
		index++;
	}

	return {
		sql: newSql,
		namedParameters
	};
}

function findMaxExistingPostgresParamNumber(sql: string) {
	let index = 0;
	let max = 0;
	while (index < sql.length) {
		const specialEnd = getSpecialTokenEnd(sql, index, 'postgres');
		if (specialEnd != null) {
			index = specialEnd;
			continue;
		}
		if (sql[index] === '$' && /\d/.test(sql[index + 1] || '')) {
			const end = readPositionalParamEnd(sql, index + 1);
			const paramNumber = parseInt(sql.slice(index + 1, end), 10);
			max = Math.max(max, paramNumber);
			index = end;
			continue;
		}
		index++;
	}
	return max;
}

function readNamedParameterEnd(sql: string, index: number) {
	let end = index;
	while (end < sql.length && isNamedParamPartChar(sql[end])) {
		end++;
	}
	return end;
}

function readPositionalParamEnd(sql: string, index: number) {
	let end = index;
	while (end < sql.length && /\d/.test(sql[end])) {
		end++;
	}
	return end;
}
