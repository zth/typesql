import { convertToCamelCaseName } from '../codegen/shared/codegen-util';
import type { RescriptEmbeddedQuery } from './types';

const SQL_NAME_BLOCK_PATTERN = /^\/\*\s*@name\s+([^*]+?)\s*\*\/$/;
const SQL_NAME_LINE_PATTERN = /^--\s*@name\s+(.+)$/;

export function parseEmbeddedQueryName(sql: string): { rawQueryName: string; queryName: string } {
	const trimmedSql = sql.trim();
	const firstLine = trimmedSql.split(/\r?\n/u, 1)[0] ?? '';
	const blockMatch = firstLine.match(SQL_NAME_BLOCK_PATTERN);
	const lineMatch = firstLine.match(SQL_NAME_LINE_PATTERN);
	const rawQueryName = (blockMatch?.[1] ?? lineMatch?.[1] ?? '').trim();

	if (rawQueryName.length === 0) {
		throw new Error('Embedded SQL is missing a required `@name` annotation.');
	}
	const queryName = convertToCamelCaseName(rawQueryName);
	if (queryName.length === 0) {
		throw new Error(`Invalid embedded SQL name "${rawQueryName}".`);
	}

	return {
		rawQueryName,
		queryName
	};
}

export function validateUniqueQueryNames(queries: RescriptEmbeddedQuery[], filePath: string) {
	const seen = new Map<string, RescriptEmbeddedQuery>();

	for (const query of queries) {
		const existing = seen.get(query.queryName);
		if (existing != null) {
			throw new Error(
				[
					`Duplicate embedded SQL name "${query.rawQueryName}" in ${filePath}.`,
					`It conflicts with "${existing.rawQueryName}" after TypeSQL normalizes names to camelCase.`
				].join(' ')
			);
		}
		seen.set(query.queryName, query);
	}
}
