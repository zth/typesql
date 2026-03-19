import { QueryType } from './types';
import { getSpecialTokenEnd, isWordPart, isWordStart, SqlDialect } from './sql-text-scanner';

const queryTypeMap: Record<string, QueryType> = {
	select: 'Select',
	insert: 'Insert',
	update: 'Update',
	delete: 'Delete',
	copy: 'Copy'
};

export function detectQueryType(sql: string, dialect: SqlDialect = 'postgres'): QueryType | null {
	let index = 0;
	let depth = 0;

	while (index < sql.length) {
		const specialEnd = getSpecialTokenEnd(sql, index, dialect);
		if (specialEnd != null) {
			index = specialEnd;
			continue;
		}

		const current = sql[index];
		if (current === '(') {
			depth++;
			index++;
			continue;
		}

		if (current === ')') {
			depth = Math.max(0, depth - 1);
			index++;
			continue;
		}

		if (isWordStart(current)) {
			const start = index;
			index++;
			while (index < sql.length && isWordPart(sql[index])) {
				index++;
			}
			if (depth === 0) {
				const keyword = sql.slice(start, index).toLowerCase();
				const queryType = queryTypeMap[keyword];
				if (queryType != null) {
					return queryType;
				}
			}
			continue;
		}

		index++;
	}

	return null;
}

export function countQuestionMarkParams(sql: string, dialect: SqlDialect = 'sqlite'): number {
	let count = 0;
	let index = 0;

	while (index < sql.length) {
		const specialEnd = getSpecialTokenEnd(sql, index, dialect);
		if (specialEnd != null) {
			index = specialEnd;
			continue;
		}

		const current = sql[index];
		if (current === '?') {
			count++;
		}

		index++;
	}

	return count;
}
