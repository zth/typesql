import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const dbPath = path.join(projectDir, 'test.db');

fs.rmSync(dbPath, { force: true });

const db = new Database(dbPath);

try {
  db.exec(`
    create table users (
      id integer primary key,
      name text not null
    );

    insert into users (id, name) values (1, 'Ada');
  `);
} finally {
  db.close();
}
