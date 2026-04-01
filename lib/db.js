/**
 * SQLite Database - History storage (30 days retention)
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'history.db');
const RETENTION_DAYS = 30;

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
  }
  return db;
}

function initTables() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS test_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT (datetime('now')),
      tested_via TEXT DEFAULT 'Unknown',
      total_links INTEGER DEFAULT 0,
      active_count INTEGER DEFAULT 0,
      down_count INTEGER DEFAULT 0,
      blocked_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      original TEXT,
      host TEXT,
      port INTEGER,
      protocol TEXT,
      type TEXT,
      status TEXT,
      status_code INTEGER,
      resolved_ip TEXT,
      response_time INTEGER,
      error TEXT,
      isp_name TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES test_sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_results_session ON test_results(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON test_sessions(created_at);
  `);
}

function saveTestSession(results, testedVia = 'Unknown') {
  const d = getDb();

  const active = results.filter(r => r.status === 'active').length;
  const down = results.filter(r => r.status === 'down').length;
  const blocked = results.filter(r => r.status === 'isp_blocked').length;

  const insertSession = d.prepare(`
    INSERT INTO test_sessions (tested_via, total_links, active_count, down_count, blocked_count)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertResult = d.prepare(`
    INSERT INTO test_results (session_id, original, host, port, protocol, type, status, status_code, resolved_ip, response_time, error, isp_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = d.transaction(() => {
    const { lastInsertRowid: sessionId } = insertSession.run(
      testedVia, results.length, active, down, blocked
    );

    for (const r of results) {
      insertResult.run(
        sessionId,
        r.original,
        r.host,
        r.port,
        r.protocol,
        r.type,
        r.status,
        r.statusCode,
        r.resolvedIp,
        r.responseTime,
        r.error,
        r.ispName
      );
    }

    return sessionId;
  });

  return transaction();
}

function getHistory(limit = 20) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM test_sessions
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

function getSessionResults(sessionId) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM test_results
    WHERE session_id = ?
    ORDER BY status, host
  `).all(sessionId);
}

function cleanOldData() {
  const d = getDb();
  d.prepare(`
    DELETE FROM test_results
    WHERE session_id IN (
      SELECT id FROM test_sessions
      WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')
    )
  `).run();

  d.prepare(`
    DELETE FROM test_sessions
    WHERE created_at < datetime('now', '-${RETENTION_DAYS} days')
  `).run();
}

module.exports = { getDb, saveTestSession, getHistory, getSessionResults, cleanOldData };
