export type PostgresBuiltinFunctionSchema = {
	schema: string;
	function_name: string;
	identity_arguments: string;
	return_type: string;
	returns_set: boolean;
	language: string;
};
