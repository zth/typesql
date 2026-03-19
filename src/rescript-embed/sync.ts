import { globSync } from 'glob';
import { errorMessage } from '../cli-io';
import type { RescriptContext } from '../rescript-cli/service';
import { resolveRescriptEmbedConfig } from './config';
import { extractEmbeddedQueriesFromFile } from './extractor';
import { buildEmbeddedRescriptFile, deleteFileIfExists, resolveEmbeddedRescriptFilePath, writeTextFileIfChanged } from './file-generator';
import type { RescriptSyncError, RescriptSyncResult, RescriptSyncSummary, ResolvedRescriptEmbedConfig } from './types';

export async function syncRescriptEmbeds(context: Pick<RescriptContext, 'config' | 'dbClient' | 'schemaInfo'>): Promise<RescriptSyncResult> {
	const rescriptConfig = resolveRescriptEmbedConfig(context.config);
	const sourceFiles = listRescriptSourceFiles(rescriptConfig);
	const errors: RescriptSyncError[] = [];
	const desiredOutputPaths = new Set<string>();
	const summary = createEmptySummary();

	for (const sourcePath of sourceFiles) {
		summary.scannedFiles += 1;
		const outputPath = resolveEmbeddedRescriptFilePath(sourcePath, rescriptConfig.srcDir, rescriptConfig.outDir);

		try {
			const queries = await extractEmbeddedQueriesFromFile(sourcePath);
			if (queries.length === 0) {
				continue;
			}

			desiredOutputPaths.add(outputPath);
			summary.sourceFilesWithEmbeds += 1;
			summary.embedCount += queries.length;

			const contents = await buildEmbeddedRescriptFile(
				context.dbClient,
				context.schemaInfo,
				sourcePath,
				rescriptConfig.srcDir,
				queries
			);
			const writeResult = writeTextFileIfChanged(outputPath, contents);
			summary.generatedFiles += 1;

			if (writeResult === 'unchanged') {
				summary.unchangedFiles += 1;
			} else {
				summary.writtenFiles += 1;
			}
		} catch (error: unknown) {
			if (deleteFileIfExists(outputPath)) {
				summary.deletedFiles += 1;
			}
			errors.push({
				filePath: sourcePath,
				message: errorMessage(error)
			});
		}
	}

	for (const generatedFile of listGeneratedRescriptFiles(rescriptConfig)) {
		if (desiredOutputPaths.has(generatedFile)) {
			continue;
		}
		if (deleteFileIfExists(generatedFile)) {
			summary.deletedFiles += 1;
		}
	}

	summary.errorCount = errors.length;

	return {
		summary,
		errors
	};
}

export function listRescriptSourceFiles(config: ResolvedRescriptEmbedConfig) {
	const sourceFiles = new Set<string>();

	for (const includePattern of config.include) {
		for (const sourcePath of globSync(includePattern, {
			absolute: true,
			cwd: config.srcDir,
			ignore: config.exclude,
			nodir: true
		})) {
			sourceFiles.add(sourcePath);
		}
	}

	return Array.from(sourceFiles).sort();
}

export function listGeneratedRescriptFiles(config: ResolvedRescriptEmbedConfig) {
	return globSync('**/*__typesql.res', {
		absolute: true,
		cwd: config.outDir,
		nodir: true
	}).sort();
}

function createEmptySummary(): RescriptSyncSummary {
	return {
		scannedFiles: 0,
		sourceFilesWithEmbeds: 0,
		generatedFiles: 0,
		writtenFiles: 0,
		unchangedFiles: 0,
		deletedFiles: 0,
		embedCount: 0,
		errorCount: 0
	};
}
