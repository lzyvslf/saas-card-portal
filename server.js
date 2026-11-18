const express = require('express');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8080;
const SESSION_TTL = 7 * 24 * 3600 * 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const yuan = (cents) => (cents / 100).toFixed(2);
const addDays = (dateStr, days) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pwd, salt, 64).toString('hex');
}
function verifyPassword(pwd, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(pwd, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch {
    return false;
  }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAgeMs) {
  res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function auth(req, res, next) {
  const sid = parseCookies(req).sid;
  if (!sid) return res.status(401).json({ error: '未登录' });
  const s = store.get('SELECT * FROM sessions WHERE token = ?', [sid]);
  if (!s || s.expire_at < now()) return res.status(401).json({ error: '登录已过期，请重新登录' });
  const user = store.get('SELECT id, tenant_id, username, role FROM users WHERE id = ?', [s.user_id]);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  req.user = user;
  req.tenantId = user.tenant_id;
  next();
}
function requireMerchant(req, res, next) {
  if (req.user.role !== 'merchant' || !req.tenantId) return res.status(403).json({ error: '仅商户账号可操作' });
  next();
}
function requireSuper(req, res, next) {
  if (req.user.role !== 'super') return res.status(403).json({ error: '无权限' });
  next();
}

/* ---------------- 公开接口 ---------------- */
app.get('/api/plans', (req, res) => {
  const plans = store.all('SELECT * FROM plans WHERE active = 1 ORDER BY module, days');
  const modules = store.all('SELECT * FROM modules');
  res.json({ plans, modules });
});

app.get('/api/modules', (req, res) => {
  res.json({ modules: store.all('SELECT * FROM modules') });
});

/* ---------------- 注册 / 登录 ---------------- */
app.post('/api/register', (req, res) => {
  const { shop_name, username, password } = req.body || {};
  const name = String(shop_name || '').trim().slice(0, 40);
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!name) return res.status(400).json({ error: '请填写店铺/公司名称' });
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(u)) return res.status(400).json({ error: '账号需为 3-30 位字母、数字或下划线' });
  if (p.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (store.get('SELECT id FROM users WHERE username = ?', [u])) return res.status(400).json({ error: '账号已存在' });

  let code;
  do { code = 'sp' + crypto.randomBytes(4).toString('hex'); } while (store.get('SELECT id FROM tenants WHERE code = ?', [code]));

  const tid = Number(store.run(
    'INSERT INTO tenants (name, code, status, plan, expire_at, created_at) VALUES (?,?,?,?,?,?)',
    [name, code, 'pending', 'free', null, now()]
  ).lastInsertRowid);
  const uid = Number(store.run('INSERT INTO users (tenant_id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)',
    [tid, u, hashPassword(p), 'merchant', now()]).lastInsertRowid);

  const sid = crypto.randomBytes(32).toString('hex');
  store.run('INSERT INTO sessions (token, user_id, created_at, expire_at) VALUES (?,?,?,?)',
    [sid, uid, now(), new Date(Date.now() + SESSION_TTL).toISOString()]);
  setCookie(res, 'sid', sid, SESSION_TTL);
  res.json({ ok: true, role: 'merchant', tenant: { id: tid, name, code } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const user = store.get('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: '账号或密码错误' });
  store.run('DELETE FROM sessions WHERE expire_at < ?', [now()]);
  const sid = crypto.randomBytes(32).toString('hex');
  store.run('INSERT INTO sessions (token, user_id, created_at, expire_at) VALUES (?,?,?,?)',
    [sid, user.id, now(), new Date(Date.now() + SESSION_TTL).toISOString()]);
  setCookie(res, 'sid', sid, SESSION_TTL);
  res.json({ ok: true, role: user.role, username: user.username });
});

app.post('/api/logout', auth, (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) store.run('DELETE FROM sessions WHERE token = ?', [sid]);
  clearCookie(res, 'sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  let tenant = null;
  let subscriptions = [];
  if (req.tenantId) {
    tenant = store.get('SELECT id, name, code, status, expire_at, created_at FROM tenants WHERE id = ?', [req.tenantId]);
    subscriptions = store.all(`
      SELECT s.module, s.plan, s.expire_at, m.name AS module_name, m.base_url, m.description
      FROM subscriptions s LEFT JOIN modules m ON m.key = s.module
      WHERE s.tenant_id = ? ORDER BY s.module`, [req.tenantId]);
  }
  res.json({ user: req.user, tenant, subscriptions });
});

app.post('/api/change-password', auth, (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) return res.status(400).json({ error: '请填写原密码和新密码' });
  if (String(new_password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const user = store.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user || !verifyPassword(old_password, user.password_hash)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  store.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(String(new_password)), user.id]);
  res.json({ ok: true });
});

/* ---------------- 卡密兑换 ---------------- */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  const block = () => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return s;
  };
  return 'SP-' + block() + '-' + block() + '-' + block();
}

app.post('/api/redeem', auth, requireMerchant, (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '请输入卡密' });
  const key = store.get('SELECT * FROM card_keys WHERE code = ?', [code]);
  if (!key) return res.status(404).json({ error: '卡密不存在，请检查后重试' });
  if (key.status === 'used') return res.status(400).json({ error: '该卡密已被使用' });
  if (key.status === 'void') return res.status(400).json({ error: '该卡密已作废' });

  const existing = store.get('SELECT * FROM subscriptions WHERE tenant_id = ? AND module = ?', [req.tenantId, key.module]);
  const base = existing && existing.expire_at > today() ? existing.expire_at : today();
  const newExpire = addDays(base, key.days);

  if (existing) {
    store.run('UPDATE subscriptions SET plan = ?, expire_at = ? WHERE id = ?', [key.plan, newExpire, existing.id]);
  } else {
    store.run('INSERT INTO subscriptions (tenant_id, module, plan, expire_at, created_at) VALUES (?,?,?,?,?)',
      [req.tenantId, key.module, key.plan, newExpire, now()]);
  }
  store.run("UPDATE card_keys SET status = 'used', used_tenant_id = ?, used_at = ? WHERE id = ?", [req.tenantId, now(), key.id]);

  const maxExpire = store.get('SELECT MAX(expire_at) AS e FROM subscriptions WHERE tenant_id = ?', [req.tenantId]).e;
  store.run("UPDATE tenants SET status = 'active', expire_at = ? WHERE id = ?", [maxExpire, req.tenantId]);

  const mod = store.get('SELECT * FROM modules WHERE key = ?', [key.module]);
  res.json({
    ok: true, module: key.module, module_name: mod ? mod.name : key.module,
    base_url: mod ? mod.base_url : '', plan: key.plan, expire_at: newExpire
  });
});

/* ---------------- 平台后台（超管） ---------------- */
app.get('/api/admin/stats', auth, requireSuper, (req, res) => {
  const merchants = store.get('SELECT COUNT(*) AS c FROM tenants').c;
  const activeSubs = store.get("SELECT COUNT(*) AS c FROM subscriptions WHERE expire_at >= ?", [today()]).c;
  const unusedKeys = store.get("SELECT COUNT(*) AS c FROM card_keys WHERE status = 'unused'").c;
  const usedKeys = store.get("SELECT COUNT(*) AS c FROM card_keys WHERE status = 'used'").c;
  const revenue = store.get("SELECT COALESCE(SUM(price_cents),0) AS s FROM card_keys WHERE status = 'used'").s;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const usedRows = store.all("SELECT substr(used_at,1,10) AS d, COUNT(*) AS c FROM card_keys WHERE status = 'used' AND used_at IS NOT NULL GROUP BY d");
  const trend = days.map((d) => ({ date: d, count: (usedRows.find((r) => r.d === d) || { c: 0 }).c }));

  const dist = store.all(`
    SELECT s.module, m.name, COUNT(*) AS c FROM subscriptions s
    LEFT JOIN modules m ON m.key = s.module GROUP BY s.module`);

  res.json({ merchants, activeSubs, unusedKeys, usedKeys, revenueCents: revenue, trend, dist });
});

app.post('/api/admin/keys', auth, requireSuper, (req, res) => {
  const { plan_id, count, batch_no } = req.body || {};
  const plan = store.get('SELECT * FROM plans WHERE id = ?', [plan_id]);
  if (!plan) return res.status(400).json({ error: '套餐不存在' });
  const n = Math.max(1, Math.min(500, parseInt(count, 10) || 1));
  const batch = String(batch_no || ('B' + Date.now().toString(36).toUpperCase())).slice(0, 30);
  const codes = [];
  const insert = store.db.prepare(
    'INSERT INTO card_keys (code, module, plan, days, price_cents, batch_no, status, created_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  const tx = store.tx(() => {
    for (let i = 0; i < n; i++) {
      let code;
      do { code = genCode(); } while (store.get('SELECT id FROM card_keys WHERE code = ?', [code]));
      insert.run(code, plan.module, plan.name, plan.days, plan.price_cents, batch, 'unused', now());
      codes.push(code);
    }
  });
  tx();
  res.json({ ok: true, codes, batch });
});

app.get('/api/admin/keys', auth, requireSuper, (req, res) => {
  const status = ['unused', 'used', 'void'].includes(req.query.status) ? req.query.status : null;
  const module = req.query.module ? String(req.query.module) : null;
  const q = String(req.query.q || '').trim();
  let sql = 'SELECT * FROM card_keys WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (module) { sql += ' AND module = ?'; params.push(module); }
  if (q) { sql += ' AND code LIKE ?'; params.push('%' + q.toUpperCase() + '%'); }
  sql += ' ORDER BY id DESC LIMIT 500';
  const list = store.all(sql, params);
  res.json({ list: list.map((k) => Object.assign({}, k, { price_yuan: yuan(k.price_cents) })) });
});

app.post('/api/admin/keys/:id/void', auth, requireSuper, (req, res) => {
  const k = store.get('SELECT * FROM card_keys WHERE id = ?', [req.params.id]);
  if (!k) return res.status(404).json({ error: '卡密不存在' });
  if (k.status !== 'unused') return res.status(400).json({ error: '仅未使用的卡密可作废' });
  store.run("UPDATE card_keys SET status = 'void' WHERE id = ?", [k.id]);
  res.json({ ok: true });
});

function sendXls(res, filename, headers, rows) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '<html><head><meta charset="utf-8"></head><body><table border="1"><tr>' +
    headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>';
  rows.forEach((r) => { html += '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>'; });
  html += '</table></body></html>';
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '.xls"');
  res.send('\uFEFF' + html);
}

app.get('/api/admin/keys/export', auth, requireSuper, (req, res) => {
  const list = store.all('SELECT * FROM card_keys ORDER BY id DESC');
  const mods = store.all('SELECT * FROM modules');
  const rows = list.map((k) => [
    k.code, (mods.find((m) => m.key === k.module) || {}).name || k.module, k.plan, k.days,
    yuan(k.price_cents), k.status === 'unused' ? '未使用' : (k.status === 'used' ? '已使用' : '已作废'),
    k.used_at || '', k.batch_no, k.created_at
  ]);
  sendXls(res, 'card-keys', ['卡密', '模块', '套餐', '天数', '价格(元)', '状态', '使用时间', '批次', '创建时间'], rows);
});

app.get('/api/admin/merchants', auth, requireSuper, (req, res) => {
  const tenants = store.all('SELECT * FROM tenants ORDER BY id DESC LIMIT 500');
  const users = store.all("SELECT tenant_id, username FROM users WHERE role = 'merchant'");
  const subs = store.all('SELECT s.*, m.name AS module_name FROM subscriptions s LEFT JOIN modules m ON m.key = s.module');
  res.json({
    list: tenants.map((t) => {
      const u = users.find((x) => x.tenant_id === t.id);
      const my = subs.filter((s) => s.tenant_id === t.id);
      return Object.assign({}, t, {
        username: u ? u.username : '',
        subscriptions: my,
        sub_text: my.map((s) => s.module_name + '至' + s.expire_at).join('；')
      });
    })
  });
});

app.get('/api/admin/merchants/export', auth, requireSuper, (req, res) => {
  const tenants = store.all('SELECT * FROM tenants ORDER BY id DESC');
  const users = store.all("SELECT tenant_id, username FROM users WHERE role = 'merchant'");
  const subs = store.all('SELECT s.*, m.name AS module_name FROM subscriptions s LEFT JOIN modules m ON m.key = s.module');
  const rows = tenants.map((t) => {
    const u = users.find((x) => x.tenant_id === t.id);
    const my = subs.filter((s) => s.tenant_id === t.id);
    return [t.name, u ? u.username : '', t.status === 'active' ? '正常' : '未激活/停用', t.expire_at || '',
      my.map((s) => s.module_name + '(' + s.plan + ')至' + s.expire_at).join('；'), t.created_at];
  });
  sendXls(res, 'merchants', ['商户', '账号', '状态', '总到期日', '订阅明细', '注册时间'], rows);
});

app.get('/api/admin/plans', auth, requireSuper, (req, res) => {
  res.json({ plans: store.all('SELECT * FROM plans ORDER BY module, days') });
});

app.post('/api/admin/plans', auth, requireSuper, (req, res) => {
  const { module, name, days, price_cents } = req.body || {};
  if (!store.get('SELECT key FROM modules WHERE key = ?', [module])) return res.status(400).json({ error: '模块不存在' });
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: '请填写套餐名称' });
  const d = Math.max(1, Math.min(3650, parseInt(days, 10) || 30));
  const p = Math.max(0, parseInt(price_cents, 10) || 0);
  store.run('INSERT INTO plans (module, name, days, price_cents, active) VALUES (?,?,?,?,1)', [module, n.slice(0, 20), d, p]);
  res.json({ ok: true });
});

app.put('/api/admin/plans/:id', auth, requireSuper, (req, res) => {
  const p = store.get('SELECT * FROM plans WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: '套餐不存在' });
  const price = req.body && req.body.price_cents !== undefined ? Math.max(0, parseInt(req.body.price_cents, 10) || 0) : p.price_cents;
  const active = req.body && req.body.active !== undefined ? (req.body.active ? 1 : 0) : p.active;
  store.run('UPDATE plans SET price_cents = ?, active = ? WHERE id = ?', [price, active, p.id]);
  res.json({ ok: true });
});

app.get('/api/admin/modules', auth, requireSuper, (req, res) => {
  res.json({ modules: store.all('SELECT * FROM modules') });
});

app.post('/api/admin/modules', auth, requireSuper, (req, res) => {
  const { key, name, base_url, description } = req.body || {};
  const k = String(key || '').trim().toLowerCase();
  const n = String(name || '').trim();
  if (!/^[a-z0-9_-]{2,30}$/.test(k)) return res.status(400).json({ error: '模块标识只能由小写字母、数字、下划线组成（2-30位）' });
  if (!n) return res.status(400).json({ error: '请填写模块名称' });
  if (store.get('SELECT key FROM modules WHERE key = ?', [k])) return res.status(400).json({ error: '模块标识已存在' });
  store.run('INSERT INTO modules (key, name, base_url, description) VALUES (?,?,?,?)',
    [k, n.slice(0, 40), String(base_url || '').trim().replace(/\/$/, ''), String(description || '').slice(0, 100)]);
  res.json({ ok: true });
});

app.put('/api/admin/modules/:key', auth, requireSuper, (req, res) => {
  const m = store.get('SELECT * FROM modules WHERE key = ?', [req.params.key]);
  if (!m) return res.status(404).json({ error: '模块不存在' });
  const b = req.body || {};
  const base = b.base_url !== undefined ? String(b.base_url).trim().replace(/\/$/, '') : m.base_url;
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 40) : m.name;
  const desc = b.description !== undefined ? String(b.description).slice(0, 100) : m.description;
  store.run('UPDATE modules SET base_url = ?, name = ?, description = ? WHERE key = ?', [base, name, desc, m.key]);
  res.json({ ok: true });
});

app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log('CardPortal 示例平台已启动: http://localhost:' + PORT);
  console.log('平台超管 admin/admin123 ｜ 演示商户 demo/demo123');
});
