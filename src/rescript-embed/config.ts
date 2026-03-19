import type { TypeSqlConfig } from '../types';
import type { ResolvedRescriptEmbedConfig } from './types';

const DEFAULT_INCLUDE = ['**/*.res'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/*__typesql.res'];

export function resolveRescriptEmbedConfig(config: TypeSqlConfig): ResolvedRescriptEmbedConfig {
	if (config.rescript == null) {
		throw new Error('Missing `rescript` config. Add `rescript.srcDir` to use `typesql rescript sync` or `watch`.');
	}

	const srcDir = config.rescript.srcDir;
	const outDir = config.rescript.outDir ?? srcDir;
	const include = config.rescript.include ?? DEFAULT_INCLUDE;
	const exclude = Array.from(new Set([...(config.rescript.exclude ?? []), ...DEFAULT_EXCLUDE]));

	return {
		srcDir,
		outDir,
		include,
		exclude
	};
}
