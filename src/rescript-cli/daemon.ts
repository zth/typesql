import fs from 'node:fs';
import net from 'node:net';
import { errorMessage, isRecord } from '../cli-io';
import type { DatabaseClient } from '../types';
import type { RescriptSchemaInfo } from './service';
import { generateReScriptWithClient } from './service';

export type RescriptDaemonRequest =
	| {
			action: 'rescript';
			name: string;
			sql: string;
	  }
	| { action: 'shutdown' };

export type RescriptDaemonResponse =
	| { ok: true; action: 'rescript'; name: string; rescript: string; originalTs?: string }
	| { ok: true; action: 'shutdown' }
	| { ok: false; error: string };

type DaemonConnection = {
	write: (response: RescriptDaemonResponse) => void;
};

function writeJsonLine(stream: NodeJS.WritableStream, value: unknown) {
	stream.write(JSON.stringify(value) + '\n');
}

export function startSocketDaemon(socketPath: string, dbClient: DatabaseClient, schemaInfo: RescriptSchemaInfo, close: () => Promise<void>) {
	try {
		if (fs.existsSync(socketPath)) {
			fs.unlinkSync(socketPath);
		}
	} catch {}

	const server = net.createServer((socket) => {
		let buffer = '';
		socket.on('data', async (chunk) => {
			buffer += chunk.toString('utf8');
			let newlineIndex;
			while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (!line.trim()) {
					continue;
				}
				try {
					const request = parseDaemonRequest(line);
					await handleDaemonRequest(request, dbClient, schemaInfo, {
						write: (response) => socket.write(JSON.stringify(response) + '\n')
					});
				} catch (error: unknown) {
					socket.write(JSON.stringify({ ok: false, error: errorMessage(error) }) + '\n');
				}
			}
		});
	});

	server.on('error', (error) => {
		console.error('IPC server error:', error);
	});

	server.listen(socketPath, () => {
		console.error(`TypeSQL daemon listening on ${socketPath}`);
	});

	const cleanup = async () => {
		try {
			server.close();
		} catch {}
		try {
			if (fs.existsSync(socketPath)) {
				fs.unlinkSync(socketPath);
			}
		} catch {}
		await close();
		process.exit(0);
	};

	process.on('SIGINT', () => {
		void cleanup();
	});
	process.on('SIGTERM', () => {
		void cleanup();
	});
}

export function startStdioDaemon(dbClient: DatabaseClient, schemaInfo: RescriptSchemaInfo, close: () => Promise<void>) {
	console.error('TypeSQL daemon listening on stdio (NDJSON)');
	let buffer = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', async (chunk) => {
		buffer += chunk.toString();
		let newlineIndex;
		while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (!line.trim()) {
				continue;
			}
			try {
				const request = parseDaemonRequest(line);
				await handleDaemonRequest(request, dbClient, schemaInfo, {
					write: (response) => writeJsonLine(process.stdout, response)
				});
			} catch (error: unknown) {
				writeJsonLine(process.stdout, { ok: false, error: errorMessage(error) } satisfies RescriptDaemonResponse);
			}
		}
	});

	const cleanup = async () => {
		await close();
		process.exit(0);
	};

	process.on('SIGINT', () => {
		void cleanup();
	});
	process.on('SIGTERM', () => {
		void cleanup();
	});
}

async function handleDaemonRequest(
	request: RescriptDaemonRequest,
	dbClient: DatabaseClient,
	schemaInfo: RescriptSchemaInfo,
	connection: DaemonConnection
): Promise<void> {
	if (request.action === 'shutdown') {
		connection.write({ ok: true, action: 'shutdown' });
		process.kill(process.pid, 'SIGTERM');
		return;
	}

	if (request.action === 'rescript') {
		try {
			const { rescript, originalTs } = await generateReScriptWithClient(dbClient, schemaInfo, request.name, request.sql);
			connection.write({ ok: true, action: 'rescript', name: request.name, rescript, originalTs });
			return;
		} catch (error: unknown) {
			connection.write({ ok: false, error: errorMessage(error) });
			return;
		}
	}

	connection.write({ ok: false, error: 'Unknown action' });
}

function parseDaemonRequest(raw: string): RescriptDaemonRequest {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || typeof parsed.action !== 'string') {
		throw new Error('Invalid daemon request.');
	}
	if (parsed.action === 'shutdown') {
		return { action: 'shutdown' };
	}
	if (parsed.action === 'rescript' && typeof parsed.name === 'string' && typeof parsed.sql === 'string') {
		return {
			action: 'rescript',
			name: parsed.name,
			sql: parsed.sql
		};
	}
	throw new Error('Invalid daemon request.');
}
