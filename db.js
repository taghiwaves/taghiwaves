const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Datenbank-Datei (wird im Root-Directory erstellt)
const dbPath = path.join(__dirname, 'taghiwaves.db');

// Datenbank initialisieren
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Datenbank-Fehler:', err);
    process.exit(1);
  } else {
    console.log('✅ SQLite Datenbank verbunden:', dbPath);
  }
});

// Alle Operationen serial ausführen (um Concurrency-Probleme zu vermeiden)
db.configure('busyTimeout', 5000);

// ============================================
// TABELLEN ERSTELLEN
// ============================================

/**
 * Initialisiert alle Tabellen
 */
function initializeTables() {
  // Tabelle: orders (Alle Bestellungen)
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_session_id TEXT UNIQUE NOT NULL,
      customer_email TEXT NOT NULL,
      product_name TEXT NOT NULL,
      price INTEGER NOT NULL,
      payment_status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `, (err) => {
    if (err) console.error('❌ orders Tabelle Fehler:', err);
    else console.log('✅ orders Tabelle bereit');
  });

  // Tabelle: downloads (Download-Tracker)
  db.run(`
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_session_id TEXT UNIQUE NOT NULL,
      downloaded BOOLEAN DEFAULT 0,
      download_count INTEGER DEFAULT 0,
      downloaded_at DATETIME,
      email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stripe_session_id) REFERENCES orders(stripe_session_id)
    );
  `, (err) => {
    if (err) console.error('❌ downloads Tabelle Fehler:', err);
    else console.log('✅ downloads Tabelle bereit');
  });

  // Tabelle: audit_logs (Sicherheits-Logs)
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `, (err) => {
    if (err) console.error('❌ audit_logs Tabelle Fehler:', err);
    else console.log('✅ audit_logs Tabelle bereit');
  });

  // Indizes für bessere Performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_orders_stripe_session_id ON orders(stripe_session_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_downloads_stripe_session_id ON downloads(stripe_session_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);`);
}

// ============================================
// PROMISE-WRAPPER (Für async/await)
// ============================================

/**
 * db.run mit Promise
 */
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
}

/**
 * db.get mit Promise
 */
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

/**
 * db.all mit Promise
 */
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// ============================================
// DATABASE OPERATIONEN
// ============================================

/**
 * Erstellt einen neuen Order
 */
async function createOrder(stripeSessionId, customerEmail, productName, price) {
  return dbRun(
    `INSERT INTO orders (stripe_session_id, customer_email, product_name, price, payment_status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [stripeSessionId, customerEmail, productName, price]
  );
}

/**
 * Markiert Order als bezahlt
 */
async function updateOrderPaymentStatus(stripeSessionId, status) {
  return dbRun(
    `UPDATE orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP 
     WHERE stripe_session_id = ?`,
    [status, stripeSessionId]
  );
}

/**
 * Holt einen Order
 */
async function getOrder(stripeSessionId) {
  return dbGet(
    `SELECT * FROM orders WHERE stripe_session_id = ?`,
    [stripeSessionId]
  );
}

/**
 * Erstellt einen Download-Eintrag
 */
async function createDownloadRecord(stripeSessionId, email) {
  return dbRun(
    `INSERT INTO downloads (stripe_session_id, email, downloaded, download_count)
     VALUES (?, ?, 0, 0)`,
    [stripeSessionId, email]
  );
}

/**
 * Holt Download-Record
 */
async function getDownloadRecord(stripeSessionId) {
  return dbGet(
    `SELECT * FROM downloads WHERE stripe_session_id = ?`,
    [stripeSessionId]
  );
}

/**
 * Markiert Download als heruntergeladen
 */
async function markAsDownloaded(stripeSessionId) {
  return dbRun(
    `UPDATE downloads 
     SET downloaded = 1, download_count = download_count + 1, downloaded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE stripe_session_id = ?`,
    [stripeSessionId]
  );
}

/**
 * Schreibt Audit-Log
 */
async function logAuditEvent(eventType, message, details = null, ipAddress = null) {
  return dbRun(
    `INSERT INTO audit_logs (event_type, message, details, ip_address)
     VALUES (?, ?, ?, ?)`,
    [eventType, message, details ? JSON.stringify(details) : null, ipAddress]
  );
}

/**
 * Holt Statistiken
 */
async function getStats() {
  const totalOrders = await dbGet(`SELECT COUNT(*) as count FROM orders WHERE payment_status = 'paid'`);
  const totalRevenue = await dbGet(`SELECT SUM(price) as total FROM orders WHERE payment_status = 'paid'`);
  const totalDownloads = await dbGet(`SELECT COUNT(*) as count FROM downloads WHERE downloaded = 1`);
  
  return {
    totalOrders: totalOrders?.count || 0,
    totalRevenue: (totalRevenue?.total || 0) / 100, // In Euro
    totalDownloads: totalDownloads?.count || 0
  };
}

/**
 * Holt alle Orders (für Admin)
 */
async function getAllOrders() {
  return dbAll(
    `SELECT o.*, d.downloaded, d.download_count 
     FROM orders o 
     LEFT JOIN downloads d ON o.stripe_session_id = d.stripe_session_id
     ORDER BY o.created_at DESC`
  );
}

/**
 * Holt Audit-Logs
 */
async function getAuditLogs(limit = 100) {
  return dbAll(
    `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
}

// ============================================
// EXPORT
// ============================================

module.exports = {
  db,
  initializeTables,
  // Promise-Wrapper
  dbRun,
  dbGet,
  dbAll,
  // Operationen
  createOrder,
  updateOrderPaymentStatus,
  getOrder,
  createDownloadRecord,
  getDownloadRecord,
  markAsDownloaded,
  logAuditEvent,
  getStats,
  getAllOrders,
  getAuditLogs
};
