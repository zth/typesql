import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import { errorMessage } from '../cli-io';
import type { RescriptContext } from '../rescript-cli/service';
import { resolveRescriptEmbedConfig } from './config';
import { extractEmbeddedQueriesFromFile } from './extractor';
import { buildEmbeddedRescriptFile, deleteFileIfExists, resolveEmbeddedRescriptFilePath, writeTextFileIfChanged } from './file-generator';
import { syncRescriptEmbeds } from './sync';

const WATCH_EVENT_DEBOUNCE_MS = 75;

type WatchOperation = 'sync' | 'remove';

type WatchOperationHandlers = {
	syncFile: (sourcePath: string) => Promise<void>;
	removeFile: (sourcePath: string) => Promise<void>;
};

export type WatchOperationQueue = {
	scheduleSync: (sourcePath: string) => void;
	scheduleRemove: (sourcePath: string) => void;
	stop: () => Promise<void>;
	waitForIdle: () => Promise<void>;
};

export async function watchRescriptEmbeds(context: RescriptContext) {
	const rescriptConfig = resolveRescriptEmbedConfig(context.config);
	const watcher = chokidar.watch(rescriptConfig.include.map((pattern) => path.join(rescriptConfig.srcDir, pattern)), {
		ignored: rescriptConfig.exclude.map((pattern) => path.join(rescriptConfig.srcDir, pattern)),
		ignoreInitial: true,
		awaitWriteFinish: {
			stabilityThreshold: 100
		}
	});
	const operationQueue = createWatchOperationQueue(
		{
			syncFile: (sourcePath) => syncChangedSourceFile(context, sourcePath),
			removeFile: (sourcePath) => removeGeneratedSourceFile(context, sourcePath)
		},
		WATCH_EVENT_DEBOUNCE_MS
	);

	watcher.on('add', (sourcePath) => {
		operationQueue.scheduleSync(sourcePath);
	});
	watcher.on('change', (sourcePath) => {
		operationQueue.scheduleSync(sourcePath);
	});
	watcher.on('unlink', (sourcePath) => {
		operationQueue.scheduleRemove(sourcePath);
	});
	watcher.on('error', (error) => {
		console.error(`Watch error: ${errorMessage(error)}`);
	});

	await waitForWatcherReady(watcher);

	const initialResult = await syncRescriptEmbeds(context);
	printSyncSummary(initialResult.summary);
	printSyncErrors(initialResult.errors);

	process.stdout.write(`watching ${rescriptConfig.srcDir}\n`);

	await new Promise<void>((resolve, reject) => {
		let stoppingPromise: Promise<void> | null = null;

		const stopWatching = async () => {
			if (stoppingPromise != null) {
				return stoppingPromise;
			}

			stoppingPromise = (async () => {
				process.off('SIGINT', handleSigint);
				process.off('SIGTERM', handleSigterm);
				await watcher.close();
				await operationQueue.stop();
			})();

			return stoppingPromise;
		};

		const handleSigint = () => {
			void stopWatching().then(() => {
				resolve();
			});
		};
		const handleSigterm = () => {
			void stopWatching().then(() => {
				resolve();
			});
		};
		const handleWatcherError = (error: unknown) => {
			void stopWatching().then(() => {
				reject(error);
			});
		};

		process.once('SIGINT', handleSigint);
		process.once('SIGTERM', handleSigterm);
		watcher.once('error', handleWatcherError);
	});
}

async function waitForWatcherReady(watcher: FSWatcher) {
	await new Promise<void>((resolve, reject) => {
		const handleReady = () => {
			watcher.off('error', handleError);
			resolve();
		};
		const handleError = (error: unknown) => {
			watcher.off('ready', handleReady);
			reject(error);
		};

		watcher.once('ready', handleReady);
		watcher.once('error', handleError);
	});
}

export function createWatchOperationQueue(
	handlers: WatchOperationHandlers,
	debounceMs: number = WATCH_EVENT_DEBOUNCE_MS
): WatchOperationQueue {
	const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const operationChains = new Map<string, Promise<void>>();
	let stopped = false;

	const clearPendingTimer = (sourcePath: string) => {
		const existingTimer = pendingTimers.get(sourcePath);
		if (existingTimer == null) {
			return;
		}
		clearTimeout(existingTimer);
		pendingTimers.delete(sourcePath);
	};

	const enqueueOperation = (sourcePath: string, operation: WatchOperation) => {
		const previous = operationChains.get(sourcePath) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				if (stopped) {
					return;
				}

				switch (operation) {
					case 'sync':
						await handlers.syncFile(sourcePath);
						return;
					case 'remove':
						await handlers.removeFile(sourcePath);
						return;
				}
			})
			.finally(() => {
				if (operationChains.get(sourcePath) === next) {
					operationChains.delete(sourcePath);
				}
			});

		operationChains.set(sourcePath, next);
	};

	return {
		scheduleSync(sourcePath: string) {
			if (stopped) {
				return;
			}

			clearPendingTimer(sourcePath);
			const timer = setTimeout(() => {
				pendingTimers.delete(sourcePath);
				enqueueOperation(sourcePath, 'sync');
			}, debounceMs);
			pendingTimers.set(sourcePath, timer);
		},

		scheduleRemove(sourcePath: string) {
			if (stopped) {
				return;
			}

			clearPendingTimer(sourcePath);
			enqueueOperation(sourcePath, 'remove');
		},

		async stop() {
			stopped = true;

			for (const timer of pendingTimers.values()) {
				clearTimeout(timer);
			}
			pendingTimers.clear();

			await Promise.allSettled(Array.from(operationChains.values()));
		},

		async waitForIdle() {
			while (pendingTimers.size > 0 || operationChains.size > 0) {
				if (pendingTimers.size > 0) {
					await new Promise((resolve) => setTimeout(resolve, debounceMs + 5));
					continue;
				}

				await Promise.allSettled(Array.from(operationChains.values()));
			}
		}
	};
}

export function printSyncSummary(summary: {
	scannedFiles: number;
	sourceFilesWithEmbeds: number;
	generatedFiles: number;
	writtenFiles: number;
	unchangedFiles: number;
	deletedFiles: number;
	embedCount: number;
	errorCount: number;
}) {
	process.stdout.write(
		[
			`scanned=${summary.scannedFiles}`,
			`embedFiles=${summary.sourceFilesWithEmbeds}`,
			`embeds=${summary.embedCount}`,
			`generated=${summary.generatedFiles}`,
			`written=${summary.writtenFiles}`,
			`unchanged=${summary.unchangedFiles}`,
			`deleted=${summary.deletedFiles}`,
			`errors=${summary.errorCount}`
		].join(' ') + '\n'
	);
}

export function printSyncErrors(errors: Array<{ filePath: string; message: string }>) {
	for (const error of errors) {
		console.error(`${path.relative(process.cwd(), error.filePath)}: ${error.message}`);
	}
}

async function removeGeneratedSourceFile(context: Pick<RescriptContext, 'config'>, sourcePath: string) {
	const rescriptConfig = resolveRescriptEmbedConfig(context.config);
	const outputPath = resolveEmbeddedRescriptFilePath(sourcePath, rescriptConfig.srcDir, rescriptConfig.outDir);
	if (deleteFileIfExists(outputPath)) {
		process.stdout.write(`removed ${path.relative(process.cwd(), outputPath)}\n`);
	}
}

async function syncChangedSourceFile(context: RescriptContext, sourcePath: string) {
	const rescriptConfig = resolveRescriptEmbedConfig(context.config);
	const outputPath = resolveEmbeddedRescriptFilePath(sourcePath, rescriptConfig.srcDir, rescriptConfig.outDir);

	try {
		const queries = await extractEmbeddedQueriesFromFile(sourcePath);
		if (queries.length === 0) {
			if (deleteFileIfExists(outputPath)) {
				process.stdout.write(`removed ${path.relative(process.cwd(), outputPath)}\n`);
			}
			return;
		}

		const contents = await buildEmbeddedRescriptFile(
			context.dbClient,
			context.schemaInfo,
			sourcePath,
			rescriptConfig.srcDir,
			queries
		);
		const writeResult = writeTextFileIfChanged(outputPath, contents);
		process.stdout.write(
			`${writeResult} ${path.relative(process.cwd(), outputPath)} embeds=${queries.length}\n`
		);
	} catch (error: unknown) {
		if (deleteFileIfExists(outputPath)) {
			process.stdout.write(`removed ${path.relative(process.cwd(), outputPath)}\n`);
		}
		console.error(`${path.relative(process.cwd(), sourcePath)}: ${errorMessage(error)}`);
	}
}
