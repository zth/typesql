import assert from 'node:assert';
import { createWatchOperationQueue } from '../src/rescript-embed/watch';

describe('createWatchOperationQueue', () => {
	it('debounces repeated sync events for the same source file', async () => {
		const events: string[] = [];
		const queue = createWatchOperationQueue(
			{
				syncFile: async (sourcePath) => {
					events.push(`sync:${sourcePath}`);
				},
				removeFile: async (sourcePath) => {
					events.push(`remove:${sourcePath}`);
				}
			},
			20
		);

		try {
			queue.scheduleSync('src/Queries.res');
			queue.scheduleSync('src/Queries.res');
			queue.scheduleSync('src/Queries.res');

			await queue.waitForIdle();

			assert.deepStrictEqual(events, ['sync:src/Queries.res']);
		} finally {
			await queue.stop();
		}
	});

	it('cancels a pending sync when the source file is removed before the debounce window closes', async () => {
		const events: string[] = [];
		const queue = createWatchOperationQueue(
			{
				syncFile: async (sourcePath) => {
					events.push(`sync:${sourcePath}`);
				},
				removeFile: async (sourcePath) => {
					events.push(`remove:${sourcePath}`);
				}
			},
			20
		);

		try {
			queue.scheduleSync('src/Queries.res');
			queue.scheduleRemove('src/Queries.res');

			await queue.waitForIdle();

			assert.deepStrictEqual(events, ['remove:src/Queries.res']);
		} finally {
			await queue.stop();
		}
	});

	it('runs remove after an in-flight sync for the same source file', async () => {
		const events: string[] = [];
		let releaseSync: (() => void) | null = null;
		const syncFinished = new Promise<void>((resolve) => {
			releaseSync = resolve;
		});
		let notifySyncStarted: (() => void) | null = null;
		const syncStarted = new Promise<void>((resolve) => {
			notifySyncStarted = resolve;
		});
		const releaseBlockedSync = () => {
			const release = releaseSync;
			if (release != null) {
				release();
			}
		};

		const queue = createWatchOperationQueue(
			{
				syncFile: async (sourcePath) => {
					events.push(`sync:start:${sourcePath}`);
					notifySyncStarted?.();
					await syncFinished;
					events.push(`sync:end:${sourcePath}`);
				},
				removeFile: async (sourcePath) => {
					events.push(`remove:${sourcePath}`);
				}
			},
			0
		);

		try {
			queue.scheduleSync('src/Queries.res');
			await syncStarted;

			queue.scheduleRemove('src/Queries.res');
			assert.deepStrictEqual(events, ['sync:start:src/Queries.res']);

			releaseBlockedSync();
			await queue.waitForIdle();

			assert.deepStrictEqual(events, [
				'sync:start:src/Queries.res',
				'sync:end:src/Queries.res',
				'remove:src/Queries.res'
			]);
		} finally {
			releaseBlockedSync();
			await queue.stop();
		}
	});
});
