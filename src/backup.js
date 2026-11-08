// Резервная копия базы: node src/backup.js
// Копия делается средствами SQLite (безопасно при работающем приложении), хранится 14 последних.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';

const dir = path.join(path.dirname(config.dbPath), 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `app-${new Date().toISOString().slice(0, 10)}.sqlite`);
await db.backup(file);
console.log(`Резервная копия: ${file} (${Math.round(fs.statSync(file).size / 1024)} КБ)`);

const old = fs.readdirSync(dir).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0, -14);
for (const f of old) fs.unlinkSync(path.join(dir, f));
db.close();
