export type RescriptEmbedLocation = {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
};

export type RescriptEmbeddedQuery = {
	index: number;
	rawQueryName: string;
	queryName: string;
	sql: string;
	location: RescriptEmbedLocation;
};

export type RescriptSyncError = {
	filePath: string;
	message: string;
};

export type RescriptSyncSummary = {
	scannedFiles: number;
	sourceFilesWithEmbeds: number;
	generatedFiles: number;
	writtenFiles: number;
	unchangedFiles: number;
	deletedFiles: number;
	embedCount: number;
	errorCount: number;
};

export type RescriptSyncResult = {
	summary: RescriptSyncSummary;
	errors: RescriptSyncError[];
};

export type ResolvedRescriptEmbedConfig = {
	srcDir: string;
	outDir: string;
	include: string[];
	exclude: string[];
};
