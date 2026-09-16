# SessionHarbor 自建云存储架构

| 项 | 内容 |
|---|---|
| 状态 | v0.3 实现稿（2026-09-15） |
| 包 | `packages/cloud-server` |

## 目标

个人/企业自建托管云，支撑多用户并发同步：

1. **账户隔离**：数据与清单严格按 `userId` 分目录，服务端不信任客户端路径  
2. **并发**：SQLite WAL + busy_timeout；文件原子写；token 热路径无全局锁  
3. **登录/改密**：注册、登录、改密、登出、`/me`  
4. **写入**：PUT 加密对象；超套餐 402  

## 分层

```
┌──────────────────────────────────────────────┐
│ 客户端 harbor CLI / GUI                       │
│  register/login/change-password/sync push-pull│
├──────────────────────────────────────────────┤
│ cloud-server (HTTP)                           │
│  auth 路由 │ sync 路由 │ 中间件 Bearer         │
├──────────────┬───────────────────────────────┤
│ auth 模块     │ storage 模块                   │
│ scrypt 密码   │ users/<userId>/**.enc.json     │
│ token SHA256  │ manifest.json 原子写           │
│ SQLite users/ │ 并发：tmp+rename               │
│ tokens        │ WAL + busy_timeout             │
└──────────────┴───────────────────────────────┘
         data/ (HARBOR_CLOUD_DATA)
           cloud.db          # 账号与 token
           users/<id>/       # 密文会话
```

## 数据模型

### users
| 字段 | 说明 |
|---|---|
| id | hex uuid |
| email | unique |
| password_hash / password_salt | scrypt |
| plan | free/pro/team |
| created_at / updated_at | |
| disabled | 封禁 |

### tokens
| 字段 | 说明 |
|---|---|
| token_hash | SHA256(token)，不存明文 |
| user_id | |
| created_at / last_used_at / revoked_at | 登出置 revoked |

## API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | /v1/auth/register | 无 | email+password |
| POST | /v1/auth/login | 无 | 返回 token |
| POST | /v1/auth/change-password | Bearer | 旧+新密码，吊销旧 token 发新 token |
| POST | /v1/auth/logout | Bearer | 吊销当前 token |
| GET | /v1/auth/me | Bearer | 账号+用量+额度 |
| GET/PUT | /v1/sync/** | Bearer | 对象读写，路径限制在用户目录 |
| GET | /healthz | 无 | 探活 |

## 并发策略

| 层 | 策略 |
|---|---|
| SQLite | `journal_mode=WAL`，`busy_timeout=5000`，短事务 |
| 密码/token | 每请求独立连接或单连接串行 prepare；scrypt 较慢可接受 |
| 文件 PUT | 写 `*.tmp` 再 `rename` 原子替换 |
| 隔离 | `users/<userId>` 前缀校验，拒绝 `..` |

## 与客户端约定

- 密文仍是客户端 AES-256-GCM；服务端只存密文  
- `passphrase` 客户端本地，不上传  
- 付费闸门：free 超 50 会话 → 402  

## 部署

```powershell
$env:HARBOR_CLOUD_PORT=8787
$env:HARBOR_CLOUD_DATA=D:\harbor-cloud\data
node packages\cloud-server\dist\server.js
```

反代 HTTPS 后即可公网使用；生产建议再加：限流、邮件验证、备份 cron。
