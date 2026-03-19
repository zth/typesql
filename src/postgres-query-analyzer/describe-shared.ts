import { NamedParamWithType } from '../types';
import { EnumMap, EnumResult } from '../drivers/postgres';
import { PostgresTypeHash } from '../drivers/types';
import { JsonType, PostgresEnumType, PostgresType } from '../sqlite-query-analyzer/types';
import { PostgresParameterDef } from './types';

export function createType(typeId: number, postgresTypes: PostgresTypeHash, enumType: EnumResult[] | undefined, checkConstraint: PostgresEnumType | undefined, jsonType: JsonType | undefined): PostgresType {
	if (enumType) {
		return createEnumType(enumType);
	}
	if (checkConstraint) {
		return checkConstraint;
	}
	if (jsonType) {
		return jsonType;
	}
	return postgresTypes[typeId] ?? 'unknown';
}

export function mapToParamDef(postgresTypes: PostgresTypeHash, enumTypes: EnumMap, paramName: string, paramTypeOid: number, checkConstraint: PostgresEnumType | undefined, notNull: boolean, isList: boolean): PostgresParameterDef {
	const arrayType = isList ? '[]' : '';
	return {
		name: paramName,
		notNull,
		type: `${createType(paramTypeOid, postgresTypes, enumTypes.get(paramTypeOid), checkConstraint, undefined)}${arrayType}` as any
	};
}

type NamedParamWithTypeAndIndex = NamedParamWithType & { index: number };
export function groupByParamNumber(params: NamedParamWithType[]): Record<number, NamedParamWithTypeAndIndex[]> {
	return params.reduce((acc, param, index) => {
		const withIndex: NamedParamWithTypeAndIndex = { ...param, index };

		if (!acc[param.paramNumber]) {
			acc[param.paramNumber] = [];
		}
		acc[param.paramNumber].push(withIndex);

		return acc;
	}, {} as Record<number, NamedParamWithTypeAndIndex[]>);
}

function createEnumType(enumList: EnumResult[]): PostgresEnumType {
	const enumListStr = enumList.map(col => `'${col.enumlabel}'`).join(',');
	return `enum(${enumListStr})`;
}
