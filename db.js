const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// 平台库为“共享库”：可用 DB_PATH 环境变量指向指定数据库文件，默认使用本地 data.db
const database = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
database.pragma('journal_mode = WAL');

database.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  plan TEXT NOT NULL DEFAULT 'basic',
  expire_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'merchant',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  role TEXT NOT NULL DEFAULT 'merchant',
  created_at TEXT NOT NULL,
  expire_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS modules (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  description TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  module TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '',
  expire_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, module)
);
CREATE TABLE IF NOT EXISTS card_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  module TEXT NOT NULL,
  plan TEXT NOT NULL,
  days INTEGER NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  batch_no TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unused',
  used_tenant_id INTEGER,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keys_status ON card_keys(status);
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON subscriptions(tenant_id);
`);

function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pwd, salt, 64).toString('hex');
}

const nowIso = new Date().toISOString();

// 模块注册表
const modules = [
  ['checkin', '扫码签到系统', 'http://localhost:8090', '活动签到 / 培训考勤 / 动态二维码'],
  ['ordering', '扫码点餐系统', 'http://localhost:8091', '桌台点餐 / 菜单管理 / 实时订单'],
  ['verify', '会员核销系统', 'http://localhost:8092', '次卡核销 / 储值扣款 / 核销流水'],
  ['booking', '小程序预约系统', 'http://localhost:8093', '微信登录 / 在线预约 / 后台管理']
];
const insertModule = database.prepare('INSERT OR IGNORE INTO modules (key, name, base_url, description) VALUES (?,?,?,?)');
modules.forEach((m) => insertModule.run(...m));

// 默认套餐（价格单位：分）
if (database.prepare('SELECT COUNT(*) AS c FROM plans').get().c === 0) {
  const plans = [
    ['checkin', '周卡', 7, 990], ['checkin', '月卡', 30, 2900], ['checkin', '年卡', 365, 19900],
    ['ordering', '周卡', 7, 1990], ['ordering', '月卡', 30, 5900], ['ordering', '年卡', 365, 39900],
    ['verify', '周卡', 7, 1990], ['verify', '月卡', 30, 5900], ['verify', '年卡', 365, 39900],
    ['booking', '周卡', 7, 990], ['booking', '月卡', 30, 2900], ['booking', '年卡', 365, 19900]
  ];
  const stmt = database.prepare('INSERT INTO plans (module, name, days, price_cents, active) VALUES (?,?,?,?,1)');
  plans.forEach((p) => stmt.run(...p));
}

// 平台超管
if (!database.prepare("SELECT id FROM users WHERE role = 'super'").get()) {
  database.prepare('INSERT INTO users (tenant_id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run(null, 'admin', hashPassword('admin123'), 'super', nowIso);
  console.log('[init] 平台超管：admin / admin123');
}

// 演示商户（已开通全部模块，便于本地演示）
if (!database.prepare("SELECT id FROM tenants WHERE code = 'demo'").get()) {
  const tid = database.prepare('INSERT INTO tenants (name, code, status, plan, expire_at, created_at) VALUES (?,?,?,?,?,?)')
    .run('演示商户', 'demo', 'active', 'pro', '2099-12-31', nowIso).lastInsertRowid;
  database.prepare('INSERT OR IGNORE INTO users (tenant_id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run(tid, 'demo', hashPassword('demo123'), 'merchant', nowIso);
  const sub = database.prepare('INSERT OR IGNORE INTO subscriptions (tenant_id, module, plan, expire_at, created_at) VALUES (?,?,?,?,?)');
  ['checkin', 'ordering', 'verify', 'booking'].forEach((m) => sub.run(tid, m, '年卡', '2099-12-31', nowIso));
  console.log('[init] 演示商户：demo / demo123（已开通全部模块）');
}

module.exports = {
  db: database,
  get: (sql, params = []) => database.prepare(sql).get(...params),
  all: (sql, params = []) => database.prepare(sql).all(...params),
  run: (sql, params = []) => database.prepare(sql).run(...params),
  tx: (fn) => database.transaction(fn)
};
