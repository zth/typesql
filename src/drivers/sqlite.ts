import { TsType } from '../mysql-mapping';
import { SQLiteType } from '../sqlite-query-analyzer/types';
import { SQLiteClient } from '../types';

function mapColumnType(sqliteType: SQLiteType, client: SQLiteClient): TsType {
	switch (sqliteType) {
		case 'INTEGER':
			return 'int';
		case 'INTEGER[]':
			return 'int[]';
		case 'TEXT':
			return 'string';
		case 'TEXT[]':
			return 'string[]';
		case 'NUMERIC':
			return 'float';
		case 'NUMERIC[]':
			return 'float[]';
		case 'REAL':
			return 'float';
		case 'REAL[]':
			return 'float[]';
		case 'DATE':
			return 'Date';
		case 'DATE_TIME':
			return 'Date';
		case 'BLOB':
			return client === 'better-sqlite3' ? 'Uint8Array' : 'ArrayBuffer';
		case 'BOOLEAN':
			return 'bool';
	}
	if (sqliteType.startsWith('ENUM')) {
		const enumValues = sqliteType.substring(sqliteType.indexOf('(') + 1, sqliteType.indexOf(')'));
		return enumValues.split(',').join(' | ') as TsType;
	}
	return 'any';
}

export const mapper: {
    mapColumnType: (sqliteType: SQLiteType, client: SQLiteClient) => TsType;
} = {
	mapColumnType
};
