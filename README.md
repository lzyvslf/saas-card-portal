# saas-card-portal · 多商户 SaaS 卡密订阅门户（示例）

一个脱敏后的教学示例：面向小商家的多租户 SaaS 订阅门户，覆盖 **注册登录、卡密兑换、订阅有效期管理、平台超管后台**。后端用 Node.js + Express + SQLite，密码 scrypt 哈希，会话走 HttpOnly Cookie。

> 本仓库由真实项目脱敏整理而来：品牌名、销售渠道、生产路径、真实业务数据均已移除；数据库文件不入库，首次启动自动建库并写入演示账号。仅作工程参考，不用于生产环境。

## 一、功能概览

### 商户侧
- 注册 / 登录 / 退出 / 修改密码
- 查看本人租户信息与各模块订阅到期日
- 输入卡密兑换订阅：已开通模块在原到期日上累加天数，未开通则新建订阅
- 兑换成功后返回对应模块的访问入口

### 平台超管侧
- 概览统计：商户数、有效订阅数、未用/已用卡密、收入汇总、近 7 日趋势、模块分布
- 卡密管理：按套餐批量生成（单次 1–500）、查询（状态/模块/关键词）、作废未使用卡密、导出表格
- 商户管理：查看商户与订阅明细、导出表格
- 套餐管理：新增套餐、改价、上下架
- 模块管理：新增/编辑可接入的业务模块及其访问地址

## 二、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 22+ | 示例在 Node v22 验证 |
| Web 框架 | Express 4 | REST + 静态页面 |
| 数据库 | better-sqlite3 | 单文件 SQLite，WAL 模式 |
| 密码 | crypto.scryptSync | 随机盐 + scrypt，定时安全比较 |
| 会话 | 随机 32 字节 token | HttpOnly Cookie，7 天有效期 |

## 三、目录结构

```
saas-card-portal/
├── server.js          # HTTP 路由：鉴权、兑换、超管后台
├── db.js              # 建表、模块/套餐/演示账号初始化
├── package.json
├── public/           # 静态前端页面（门户/登录/商户中心/后台）
│   ├── index.html
│   ├── login.html
│   ├── console.html
│   ├── admin.html
│   ├── style.css
│   └── platform.css
├── LICENSE
└── .gitignore
```

## 四、本地运行

```powershell
# 安装依赖（better-sqlite3 为原生模块，需匹配本机 Node 版本）
npm install

# 启动，默认 8080
npm start
# 或指定端口
$env:PORT=8080; node server.js
```

启动后访问 http://localhost:8080 。

### 演示账号（仅本地演示）

| 角色 | 账号 | 密码 | 说明 |
|---|---|---|---|
| 平台超管 | `admin` | `admin123` | 发卡、看商户、管理套餐与模块 |
| 演示商户 | `demo` | `demo123` | 已开通全部模块，便于演示兑换流程 |

> 这些是写死在初始化脚本里的本地占位账号，上线前必须替换或改为环境变量注入。

## 五、数据模型（核心表）

- `tenants`：商户租户（名称、编码、状态、套餐、总到期日）
- `users`：账号（租户归属、用户名、密码哈希、角色：merchant / super）
- `sessions`：会话 token、用户、过期时间
- `modules`：可接入的业务模块（标识、名称、访问地址、说明）
- `plans`：套餐（模块、名称、天数、价格，单位：分）
- `subscriptions`：订阅（租户 + 模块唯一，套餐、到期日）
- `card_keys`：卡密（编码、模块、套餐、天数、价格、批次、状态：unused/used/void、使用记录）

## 六、主要接口

### 公开
- `GET /api/plans` 套餐与模块列表
- `GET /api/modules` 模块列表

### 账号
- `POST /api/register` 注册商户
- `POST /api/login` 登录
- `POST /api/logout` 退出
- `GET /api/me` 当前账号、租户与订阅
- `POST /api/change-password` 修改密码

### 商户
- `POST /api/redeem` 卡密兑换（需商户登录）

### 超管
- `GET /api/admin/stats` 概览统计
- `POST /api/admin/keys` 批量生成卡密
- `GET /api/admin/keys` 卡密查询
- `POST /api/admin/keys/:id/void` 作废卡密
- `GET /api/admin/keys/export` 导出卡密表
- `GET /api/admin/merchants` 商户列表
- `GET /api/admin/merchants/export` 导出商户表
- `GET/POST/PUT /api/admin/plans` 套餐管理
- `GET/POST/PUT /api/admin/modules` 模块管理

## 七、合规与边界

- 仓库内**不含**任何真实商户、客户、订单或业务数据；数据库文件由 `.gitignore` 排除。
- 价格、套餐、模块名称均为演示用途。
- 隐私政策、用户协议页面中的运营主体、联系方式、ICP 备案号均为占位，正式上线前需补全。
- 本示例只演示多租户订阅与卡密核销的工程实现，**不涉及任何金融交易、荐股或收益承诺**。

## 八、许可证

MIT，见 [LICENSE](LICENSE)。
