import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseEmbeddedQueryName, validateUniqueQueryNames } from './query-name';
import type { RescriptEmbeddedQuery } from './types';

const execFileAsync = promisify(execFile);
const GENERATED_EXTENSION = 'generated.typesql';
let cachedRescriptToolsScriptPath: string | undefined;

type ExtractEmbeddedLocation = {
	line: number;
	character: number;
};

type ExtractEmbeddedResult = {
	extensionName: string;
	contents: string;
	loc: {
		start: ExtractEmbeddedLocation;
		end: ExtractEmbeddedLocation;
	};
};

export async function extractEmbeddedQueriesFromFile(filePath: string): Promise<RescriptEmbeddedQuery[]> {
	const scriptPath = resolveRescriptToolsScriptPath();
	const { stdout } = await execFileAsync(process.execPath, [scriptPath, 'extract-embedded', GENERATED_EXTENSION, filePath], {
		maxBuffer: 10 * 1024 * 1024
	});

	const rawResults = parseExtractEmbeddedOutput(stdout);
	const queries = rawResults.map((result, index) => {
		const { rawQueryName, queryName } = parseEmbeddedQueryName(result.contents);

		return {
			index: index + 1,
			rawQueryName,
			queryName,
			sql: result.contents,
			location: {
				startLine: result.loc.start.line,
				startCharacter: result.loc.start.character,
				endLine: result.loc.end.line,
				endCharacter: result.loc.end.character
			}
		};
	});

	validateUniqueQueryNames(queries, filePath);
	return queries;
}

function parseExtractEmbeddedOutput(stdout: string): ExtractEmbeddedResult[] {
	if (stdout.trim().length === 0) {
		return [];
	}

	const parsed = JSON.parse(stdout) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error('Unexpected output from ReScript extract-embedded.');
	}

	return parsed.map((value) => {
		if (
			typeof value !== 'object' ||
			value == null ||
			typeof (value as ExtractEmbeddedResult).contents !== 'string' ||
			typeof (value as ExtractEmbeddedResult).extensionName !== 'string' ||
			typeof (value as ExtractEmbeddedResult).loc?.start?.line !== 'number' ||
			typeof (value as ExtractEmbeddedResult).loc?.start?.character !== 'number' ||
			typeof (value as ExtractEmbeddedResult).loc?.end?.line !== 'number' ||
			typeof (value as ExtractEmbeddedResult).loc?.end?.character !== 'number'
		) {
			throw new Error('Unexpected extract-embedded payload shape.');
		}

		return value as ExtractEmbeddedResult;
	});
}

function resolveRescriptToolsScriptPath() {
	if (cachedRescriptToolsScriptPath != null) {
		return cachedRescriptToolsScriptPath;
	}

	try {
		const rescriptPackagePath = require.resolve('rescript/package.json');
		cachedRescriptToolsScriptPath = path.join(path.dirname(rescriptPackagePath), 'cli', 'rescript-tools.js');
		return cachedRescriptToolsScriptPath;
	} catch (error) {
		throw new Error(`Failed to locate the ReScript compiler tools. Install TypeSQL dependencies before using embedded ReScript commands: ${String(error)}`);
	}
}
