import type { AnalysisDiagnostic } from '../analysis-types';
import type { NamedParamInfo, NamedParamWithType } from '../types';
import type { EnumMap } from '../drivers/postgres';
import { PostgresDescribe } from '../drivers/types';
import { postgresTypes } from '../dialects/postgres';
import { detectQueryType } from '../sql-query-type';
import { createType, groupByParamNumber, mapToParamDef } from './describe-shared';
import { PostgresColumnInfo, PostgresParameterDef, PostgresSchemaDef } from './types';

export function createBaselineSchema(sql: string, postgresDescribeResult: PostgresDescribe, namedParameters: NamedParamInfo[], enumTypes: EnumMap): PostgresSchemaDef {
	const queryType = detectQueryType(sql, 'postgres') ?? (postgresDescribeResult.columns.length > 0 ? 'Select' : 'Update');
	const hasReturningColumns = queryType !== 'Select' && queryType !== 'Copy' && postgresDescribeResult.columns.length > 0;
	const baseline: PostgresSchemaDef = {
		sql,
		queryType,
		multipleRowsResult: queryType === 'Select',
		columns: createFallbackColumns(postgresDescribeResult, enumTypes),
		parameters: createFallbackParameters(postgresDescribeResult, namedParameters, enumTypes)
	};
	if (hasReturningColumns) {
		baseline.returning = true;
	}
	return baseline;
}

export function addAnalysis(schema: PostgresSchemaDef, mode: 'degraded' | 'describe-only', diagnostic: AnalysisDiagnostic): PostgresSchemaDef {
	const previousDiagnostics = schema.analysis?.diagnostics || [];
	const previousMode = schema.analysis?.mode;
	const nextMode = previousMode === 'describe-only' || mode === 'describe-only' ? 'describe-only' : 'degraded';
	return {
		...schema,
		analysis: {
			mode: nextMode,
			diagnostics: previousDiagnostics.concat(diagnostic)
		}
	};
}

export function toErrorMessage(error: unknown) {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function createFallbackColumns(postgresDescribeResult: PostgresDescribe, enumTypes: EnumMap): PostgresColumnInfo[] {
	return postgresDescribeResult.columns.map((col) => ({
		name: col.name,
		type: createType(col.typeId, postgresTypes, enumTypes.get(col.typeId), undefined, undefined),
		notNull: false,
		table: ''
	}));
}

function createFallbackParameters(postgresDescribeResult: PostgresDescribe, namedParameters: NamedParamInfo[], enumTypes: EnumMap): PostgresParameterDef[] {
	const params = namedParameters.length > 0
		? namedParameters
		: postgresDescribeResult.parameters.map((_, index) => ({
			paramName: `param${index + 1}`,
			paramNumber: index + 1
		}));
	const paramWithTypes = params.map(param => ({
		...param,
		typeOid: postgresDescribeResult.parameters[param.paramNumber - 1] ?? 705
	} satisfies NamedParamWithType));
	const paramMap = groupByParamNumber(paramWithTypes);
	return Object.values(paramMap).map(group => mapToParamDef(postgresTypes, enumTypes, group[0].paramName, group[0].typeOid, undefined, false, false));
}
