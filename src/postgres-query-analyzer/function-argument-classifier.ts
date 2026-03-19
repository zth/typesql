import { A_expr_typecastContext, AexprconstContext, Array_exprContext, C_expr_exprContext, ColidContext, ColumnrefContext, Func_arg_exprContext, IdentifierContext, IndirectionContext } from '@wsporto/typesql-parser/postgres/PostgreSQLParser';
import { ParserRuleContext } from '@wsporto/typesql-parser';

export type FunctionArgumentClassifierColumn = {
	column_name: string;
	table: string;
	type: string;
	schema: string;
	record_type_name?: string;
	record_type_schema?: string;
};

export function classifyFunctionArgumentTypes(funcArgExprList: Func_arg_exprContext[], fromColumns: FunctionArgumentClassifierColumn[]): string[] {
	return funcArgExprList.map(funcArgExpr => classifyFunctionArgumentType(funcArgExpr, fromColumns));
}

function classifyFunctionArgumentType(funcArgExpr: Func_arg_exprContext, fromColumns: FunctionArgumentClassifierColumn[]): string {
	const aExpr = funcArgExpr.a_expr();
	const explicitCastType = getExplicitTypeCast(aExpr);
	if (explicitCastType) {
		return explicitCastType;
	}
	if (isArrayLiteralExpression(aExpr)) {
		return 'anyarray';
	}

	const cExprList = collectContextsOfType(aExpr, C_expr_exprContext) as C_expr_exprContext[];
	if (cExprList.length !== 1) {
		return 'unknown';
	}

	const cExpr = cExprList[0];
	if (cExpr.PARAM()) {
		return 'unknown';
	}

	const aExprConst = cExpr.aexprconst();
	if (aExprConst) {
		return classifyConst(aExprConst);
	}

	const columnref = cExpr.columnref();
	if (columnref) {
		return classifyColumnRef(columnref, fromColumns);
	}

	return 'unknown';
}

function classifyConst(aExprConst: AexprconstContext): string {
	if (aExprConst.iconst()) {
		return 'int4';
	}
	if (aExprConst.fconst()) {
		return 'float4';
	}
	if (aExprConst.sconst()) {
		return 'text';
	}
	if (aExprConst.TRUE_P() || aExprConst.FALSE_P()) {
		return 'bool';
	}
	if (aExprConst.NULL_P()) {
		return 'null';
	}
	if (aExprConst.bconst()) {
		return 'bit';
	}
	if (aExprConst.xconst()) {
		return 'bytea';
	}
	const typeFunctionName = aExprConst.func_name()?.type_function_name()?.getText().toLowerCase();
	if (typeFunctionName === 'date') {
		return 'date';
	}
	return 'unknown';
}

function classifyColumnRef(columnref: ColumnrefContext, fromColumns: FunctionArgumentClassifierColumn[]): string {
	const baseName = getColidText(columnref.colid());
	const indirection = columnref.indirection();
	if (!indirection) {
		const recordType = findCompositeArgumentType(baseName, fromColumns);
		if (recordType) {
			return recordType;
		}
		return findColumnType('', baseName, fromColumns) || 'unknown';
	}

	const fieldName = getIndirectionText(indirection);
	if (fieldName === '*') {
		return findCompositeArgumentType(baseName, fromColumns) || 'record';
	}
	return findColumnType(baseName, fieldName, fromColumns) || 'unknown';
}

function findColumnType(prefix: string, name: string, fromColumns: FunctionArgumentClassifierColumn[]): string | null {
	const matches = fromColumns.filter(col =>
		(prefix === '' || col.table.toLowerCase() === prefix.toLowerCase())
		&& col.column_name.toLowerCase() === name.toLowerCase()
	);
	if (matches.length === 0) {
		return null;
	}
	const uniqueTypes = [...new Set(matches.map(col => col.type.toLowerCase()))];
	return uniqueTypes.length === 1 ? uniqueTypes[0] : 'unknown';
}

function findCompositeArgumentType(alias: string, fromColumns: FunctionArgumentClassifierColumn[]): string | null {
	const matches = fromColumns.filter(col => col.table.toLowerCase() === alias.toLowerCase());
	if (matches.length === 0) {
		return null;
	}
	const recordTypes = [...new Set(matches.map(getCompositeTypeName).filter((typeName): typeName is string => typeName != null))];
	if (recordTypes.length === 1) {
		return recordTypes[0];
	}
	return 'record';
}

function getCompositeTypeName(column: FunctionArgumentClassifierColumn): string | null {
	if (!column.record_type_name) {
		return null;
	}
	return column.record_type_schema ? `${column.record_type_schema}.${column.record_type_name}` : column.record_type_name;
}

function getExplicitTypeCast(ctx: ParserRuleContext): string | null {
	const typecasts = collectContextsOfType(ctx, A_expr_typecastContext) as A_expr_typecastContext[];
	const lastTypecast = typecasts.at(-1);
	return lastTypecast?.typename_list().at(-1)?.getText().toLowerCase() || null;
}

function isArrayLiteralExpression(ctx: ParserRuleContext) {
	return collectContextsOfType(ctx, Array_exprContext).length > 0 || /^array\s*\[/i.test(ctx.getText());
}

function collectContextsOfType(ctx: ParserRuleContext, targetType: any): ParserRuleContext[] {
	const results: ParserRuleContext[] = [];
	if (ctx instanceof targetType) {
		results.push(ctx);
	}
	ctx.children?.forEach(child => {
		if (child instanceof ParserRuleContext) {
			results.push(...collectContextsOfType(child, targetType));
		}
	});
	return results;
}

function getColidText(colid: ColidContext): string {
	const identifier = colid.identifier();
	if (identifier) {
		return getIdentifierText(identifier);
	}
	const unreservedKeyword = colid.unreserved_keyword();
	if (unreservedKeyword) {
		return unreservedKeyword.getText();
	}
	return '';
}

function getIndirectionText(indirection: IndirectionContext): string {
	const indirectionElements = indirection.indirection_el_list();
	if (indirectionElements && indirectionElements.length === 1) {
		const colLabel = indirectionElements[0].attr_name()?.colLabel();
		if (colLabel) {
			return getColidText(colLabel);
		}
		if (indirectionElements[0].STAR()) {
			return '*';
		}
	}
	return '';
}

function getIdentifierText(identifier: IdentifierContext): string {
	const quotedIdentifier = identifier.QuotedIdentifier();
	if (quotedIdentifier) {
		return quotedIdentifier.getText().slice(1, -1);
	}
	return identifier.getText();
}
