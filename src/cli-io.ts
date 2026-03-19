import fs from 'node:fs';
import dotenv from 'dotenv';

export async function readStdinIfNeeded(value?: string): Promise<string> {
	if (value != null && value.length > 0) {
		return value;
	}
	if (!process.stdin.isTTY) {
		return readAllStdin();
	}
	return '';
}

export async function readAllStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

export function loadEnvFileIfPresent(envFile?: string) {
	if (!envFile) return;
	if (fs.existsSync(envFile)) {
		dotenv.config({ path: envFile, quiet: true });
	} else {
		console.warn(`Warning: .env file not found: ${envFile}`);
	}
}

export function parseJsonInput(raw: string, label: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error: unknown) {
		throw new Error(`Invalid ${label} JSON: ${errorMessage(error)}`);
	}
}

export function readJsonFile(filePath: string, label: string): unknown {
	const raw = fs.readFileSync(filePath, 'utf8');
	return parseJsonInput(raw, label);
}

export function writeJsonOutput(value: unknown) {
	process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value != null && !Array.isArray(value);
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(message);
	}
	return value;
}

export function readRequiredString(value: Record<string, unknown>, key: string, message: string): string {
	const result = readOptionalString(value, key);
	if (result == null) {
		throw new Error(message);
	}
	return result;
}

export function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
	return typeof value[key] === 'string' ? value[key] : undefined;
}

export function readBooleanFlag(value: Record<string, unknown>, key: string): boolean {
	return value[key] === true;
}
