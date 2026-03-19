import { NamedParamWithType, TypeSqlError } from '../types';
import { DescribeParameters, DescribeQueryColumn, PostgresDescribe, PostgresTypeHash } from '../drivers/types';
import { postgresDescribe, EnumMap, EnumResult, CheckConstraintResult } from '../drivers/postgres';
import { Sql } from 'postgres';
import { safeParseSql } from './parser';
import { replacePostgresParams } from '../sqlite-query-analyzer/replace-list-params';
import { errAsync, ok, Result, ResultAsync } from 'neverthrow';
import { postgresTypes } from '../dialects/postgres';
import { NotNullInfo, PostgresTraverseResult } from './traverse';
import { describeNestedQuery } from '../sqlite-query-analyzer/sqlite-describe-nested-query';
import { isLeft } from 'fp-ts/lib/Either';
import { hasAnnotation, preprocessSql } from '../describe-query';
import { describeDynamicQuery2 } from '../describe-dynamic-query';
import { PostgresColumnInfo, PostgresParameterDef, PostgresSchemaDef } from './types';
import { JsonType, PostgresEnumType, PostgresType } from '../sqlite-query-analyzer/types';
import { PostgresSchemaInfo } from '../schema-info';
import { replaceOrderByParamWithPlaceholder, replaceOrderByPlaceholderWithBuildOrderBy, replaceOrderByPlaceholderWithConstant } from './util';
import { addAnalysis, createBaselineSchema, toErrorMessage } from './degraded-analysis';
import { createType, groupByParamNumber, mapToParamDef } from './describe-shared';

function describeQueryRefine(describeParameters: DescribeParameters): Result<PostgresSchemaDef, TypeSqlError> {
	const { sql, postgresDescribeResult, namedParameters, schemaInfo } = describeParameters;
	const { columns: dbSchema, enumTypes, userFunctions, checkConstraints } = schemaInfo;
	const generateNestedInfo = hasAnnotation(sql, '@nested');
	const generateDynamicQueryInfo = hasAnnotation(sql, '@dynamicQuery');
	const baselineSchema = createBaselineSchema(sql, postgresDescribeResult, namedParameters, enumTypes);

	const parseResult = safeParseSql(sql, dbSchema, checkConstraints, userFunctions, { collectNestedInfo: generateNestedInfo, collectDynamicQueryInfo: generateDynamicQueryInfo });
	if (parseResult.isErr()) {
		return ok(addAnalysis(baselineSchema, 'describe-only', {
			code: 'postgres.describe_only_fallback',
			message: parseResult.error
		}));
	}
	const traverseResult = parseResult.value;
	const paramWithTypes = namedParameters.map(param => {
		const paramTypeOid = postgresDescribeResult.parameters[param.paramNumber - 1];
		return {
			...param,
			typeOid: paramTypeOid
		} satisfies NamedParamWithType
	});

	try {
		//replace list parameters
		const newSql = replacePostgresParams(sql, traverseResult.parameterList, namedParameters.map(param => param.paramName));
		const parameters = transformToParamDefList(traverseResult, enumTypes, paramWithTypes);

		let descResult: PostgresSchemaDef = {
			sql: newSql,
			queryType: traverseResult.queryType,
			multipleRowsResult: traverseResult.multipleRowsResult,
			columns: getColumnsForQuery(generateNestedInfo, traverseResult, postgresDescribeResult, enumTypes, checkConstraints),
			parameters: getParametersForQuery(traverseResult, parameters)
		};
		if (traverseResult.queryType === 'Update') {
			descResult.data = getDataParametersForQuery(traverseResult, parameters);
		}
		if (traverseResult.returning) {
			descResult.returning = traverseResult.returning;
		}
		if (traverseResult.orderByColumns) {
			descResult.orderByColumns = traverseResult.orderByColumns;
		}
		if (traverseResult.relations) {
			const nestedResult = describeNestedQuery(descResult.columns, traverseResult.relations || []);
			if (isLeft(nestedResult)) {
				descResult = addAnalysis(descResult, 'degraded', {
					code: 'postgres.nested_info_unavailable',
					message: nestedResult.left.description
				});
			} else {
				descResult.nestedInfo = nestedResult.right;
			}
		}
		if (traverseResult.dynamicQueryInfo) {
			try {
				const orderByColumns = describeParameters.hasOrderBy ? traverseResult.orderByColumns || [] : [];
				const dynamicSqlQueryInfo = describeDynamicQuery2(traverseResult.dynamicQueryInfo, namedParameters.map(param => param.paramName), orderByColumns);
				descResult.dynamicSqlQuery2 = dynamicSqlQueryInfo;
			} catch (error) {
				descResult = addAnalysis(descResult, 'degraded', {
					code: 'postgres.dynamic_query_info_unavailable',
					message: toErrorMessage(error)
				});
			}
		}
		return ok(descResult);
	} catch (error) {
		return ok(addAnalysis(baselineSchema, 'describe-only', {
			code: 'postgres.describe_only_fallback',
			message: toErrorMessage(error)
		}));
	}
}

function mapToColumnInfo(collectNestedInfo: boolean, col: DescribeQueryColumn, posgresTypes: PostgresTypeHash, enumTypes: EnumMap, checkConstraints: CheckConstraintResult, colInfo: NotNullInfo): PostgresColumnInfo {
	const constraintKey = `[${colInfo.schema}][${colInfo.table}][${colInfo.column_name}]`;
	const columnInfo: PostgresColumnInfo = {
		name: col.name,
		notNull: !colInfo.is_nullable,
		type: createType(col.typeId, posgresTypes, enumTypes.get(col.typeId), checkConstraints[constraintKey], colInfo.jsonType),
		table: colInfo.table
	}
	if (collectNestedInfo) {
		columnInfo.intrinsicNotNull = !colInfo.original_is_nullable;
	}
	return columnInfo;
}

export function describeQuery(postgres: Sql, sql: string, schemaInfo: PostgresSchemaInfo): ResultAsync<PostgresSchemaDef, TypeSqlError> {
	const newSql = replaceOrderByParamWithPlaceholder(sql);
	let preprocessed: string;
	let namedParameters: { paramName: string; paramNumber: number }[];
	try {
		const preprocessResult = preprocessSql(newSql.sql, 'postgres');
		preprocessed = preprocessResult.sql;
		namedParameters = preprocessResult.namedParameters;
	} catch (error) {
		const err = error as Error;
		return errAsync({
			name: 'Invalid SQL',
			description: err.message
		});
	}
	return postgresDescribe(postgres, preprocessed).andThen(analyzeResult => {

		const describeParameters: DescribeParameters = {
			sql: preprocessed,
			postgresDescribeResult: analyzeResult,
			namedParameters,
			schemaInfo,
			hasOrderBy: newSql.replaced
		};
		return describeQueryRefine(describeParameters).map(desc => {
			const { orderByColumns: _ignoredOrderByColumns, ...rest } = desc;
			const result: PostgresSchemaDef = { ...rest };
			if (newSql.replaced && desc.orderByColumns?.length) {
				result.sql = replaceOrderByPlaceholderWithBuildOrderBy(desc.sql);
				result.orderByColumns = desc.orderByColumns;
			} else if (newSql.replaced) {
				result.sql = replaceOrderByPlaceholderWithConstant(desc.sql);
				result.analysis = addAnalysis(result, result.analysis?.mode === 'describe-only' ? 'describe-only' : 'degraded', {
					code: 'postgres.order_by_fallback_disabled',
					message: 'Dynamic ORDER BY generation was disabled because semantic analysis was unavailable.'
				}).analysis;
			}
			return result;
		});
	});
}
function getColumnsForQuery(collectNestedInfo: boolean, traverseResult: PostgresTraverseResult, postgresDescribeResult: PostgresDescribe, enumTypes: EnumMap, checkConstraints: CheckConstraintResult): PostgresColumnInfo[] {
	return postgresDescribeResult.columns.map((col, index) => mapToColumnInfo(collectNestedInfo, col, postgresTypes, enumTypes, checkConstraints, traverseResult.columns[index]))
}

function transformToParamDefList(traverseResult: PostgresTraverseResult, enumTypes: EnumMap, params: NamedParamWithType[]): PostgresParameterDef[] {
	const parametersNullability = traverseResult.parametersNullability.concat(traverseResult.whereParamtersNullability || []);
	const paramMap = groupByParamNumber(params);
	return Object.values(paramMap).map(group => {
		const notNull = group.every(param => parametersNullability[param.index]?.isNotNull);
		const paramList = group.every(param => traverseResult.parameterList[param.index]);
		const paramCheckConstraint = group.map(param => parametersNullability[param.index]?.checkConstraint).find(Boolean);
		const paramResult = mapToParamDef(postgresTypes, enumTypes, group[0].paramName, group[0].typeOid, paramCheckConstraint, notNull, paramList);
		return paramResult;
	})
}

function getColumnsForCopyStmt(traverseResult: PostgresTraverseResult): PostgresParameterDef[] {
	return traverseResult.columns.map(col => {
		const result: PostgresParameterDef = {
			name: col.column_name,
			type: col.type ?? 'unknown',
			notNull: !col.is_nullable
		}
		return result;
	});
}

function getParametersForQuery(traverseResult: PostgresTraverseResult, params: PostgresParameterDef[]): PostgresParameterDef[] {
	if (traverseResult.queryType === 'Update') {
		const dataParamCount = traverseResult.parametersNullability.length;
		const dataParams = params.slice(0, dataParamCount);
		const whereParams = params.slice(dataParamCount);
		const dataParamNames = new Set(dataParams.map(p => p.name));
		// Filter out whereParams that are already in dataParams
		const filteredWhereParams = whereParams.filter(p => !dataParamNames.has(p.name));

		return filteredWhereParams;
	}
	if (traverseResult.queryType === 'Copy') {
		return getColumnsForCopyStmt(traverseResult);
	}
	return params;
}

function getDataParametersForQuery(traverseResult: PostgresTraverseResult, params: PostgresParameterDef[]): PostgresParameterDef[] {
	const dataParams = params.slice(0, traverseResult.parametersNullability.length);
	return dataParams;
}
