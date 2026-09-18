import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, language TEXT, crop TEXT, last TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS quota (day TEXT, id TEXT, used INTEGER, PRIMARY KEY(day,id));
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, created INTEGER);
    `);
    this.cleanup();
  }
  cleanup() {
    this.db.prepare('DELETE FROM users WHERE updated < ?').run(Date.now() - 7 * 86400000);
    this.db.prepare('DELETE FROM updates WHERE created < ?').run(Date.now() - 2 * 86400000);
    this.db.prepare('DELETE FROM quota WHERE day < ?').run(new Date(Date.now() - 86400000).toISOString().slice(0,10));
  }
  get(id) {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(String(id));
    if (user && user.updated < Date.now() - 7 * 86400000) { this.delete(id); return undefined; }
    return user;
  }
  save(id, patch) {
    const u = { language: 'ru', crop: 'potato', last: null, ...this.get(id), ...patch };
    this.db.prepare('INSERT OR REPLACE INTO users VALUES (?, ?, ?, ?, ?)').run(String(id), u.language, u.crop, u.last, Date.now());
    return u;
  }
  delete(id) { this.db.prepare('DELETE FROM users WHERE id = ?').run(String(id)); }
  seen(id) { return Boolean(this.db.prepare('SELECT 1 FROM updates WHERE id = ?').get(id)); }
  mark(id) { this.db.prepare('INSERT OR IGNORE INTO updates VALUES (?, ?)').run(id, Date.now()); }
  reserve(id, globalLimit, userLimit) {
    const day = new Date().toISOString().slice(0,10);
    const count = who => this.db.prepare('SELECT used FROM quota WHERE day = ? AND id = ?').get(day, who)?.used || 0;
    if (count('*') >= globalLimit || count(String(id)) >= userLimit) return false;
    const add = this.db.prepare('INSERT INTO quota VALUES (?, ?, 1) ON CONFLICT(day,id) DO UPDATE SET used=used+1');
    this.db.exec('BEGIN');
    try { add.run(day, '*'); add.run(day, String(id)); this.db.exec('COMMIT'); }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return true;
  }
  close() { this.db.close(); }
}
