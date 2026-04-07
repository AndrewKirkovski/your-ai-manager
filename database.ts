import Database from 'better-sqlite3';
import {SCHEMA_SQL, INDEXES_SQL} from './schema';

const DB_PATH = process.env.DB_PATH || 'bot.sqlite';
// If the path ends with .json (legacy), switch to .sqlite
const sqlitePath = DB_PATH.endsWith('.json')
    ? DB_PATH.replace(/\.json$/, '.sqlite')
    : DB_PATH;

const db = new Database(sqlitePath);

// Performance and safety pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(SCHEMA_SQL);
db.exec(INDEXES_SQL);

export default db;
