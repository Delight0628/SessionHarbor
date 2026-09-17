# 用 Supabase / Neon 免费 Postgres 跑 SessionHarbor Cloud

设置 `DATABASE_URL` 后，服务端自动切换为 Postgres（账号 + 密文对象都在库里，**不需要挂盘**）。

## 1. 开一个免费库

### Supabase
1. https://supabase.com 新建项目  
2. Project Settings → Database → Connection string → **URI**（Session pooler 亦可）  
3. 复制 `postgresql://...`  

### Neon
1. https://neon.tech 新建项目  
2. Copy connection string  

## 2. 启动服务端

```powershell
# Session pooler（东京区示例；ref/密码换成你的）
$env:DATABASE_URL = "postgresql://postgres.<project-ref>:<密码>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres"
# 若公司网络 SSL 中间人导致 self signed certificate：
$env:HARBOR_CLOUD_PG_SSL_INSECURE = "1"
$env:HARBOR_CLOUD_ADMIN_TOKEN = "<强随机>"
$env:HARBOR_CLOUD_MAIL = "console"
$env:HARBOR_CLOUD_REQUIRE_EMAIL_VERIFY = "1"
$env:PORT = "8080"
node packages\cloud-server\dist\server.js
```

本机实测（Delight0628 / ap-northeast-1）：

```text
OK postgresql://postgres.hnrvuzgljxwixspbwgaw:***@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres
healthz → {"backend":"postgres"}
register + sync PUT/GET 200
```

日志应显示：`后端: postgres (DATABASE_URL)`  
`/healthz` 返回 `"backend":"postgres"`。

## 3. 部署到 Railway / Render / Fly（任意 Node 主机）

只设环境变量即可，**不必 Volume**：

```text
DATABASE_URL=postgresql://...
HARBOR_CLOUD_ADMIN_TOKEN=...
HARBOR_CLOUD_MAIL=console
HARBOR_CLOUD_REQUIRE_EMAIL_VERIFY=1
PORT=8080
```

表会在首次启动自动创建：`harbor_users` / `harbor_tokens` / `harbor_objects`。

## 4. 客户端

```powershell
harbor register --email you@x.com --password ****** --endpoint https://你的域名
harbor login    --email you@x.com --password ****** --endpoint https://你的域名
harbor sync push session --id <uuid>
```

## 5. 注意

| 项 | 说明 |
|---|---|
| 免费档限制 | Supabase/Neon 有连接数/存储配额；个人订阅够用 |
| 密文 | 仍是客户端 AES-256-GCM，库内只有密文 BYTEA |
| 无 DATABASE_URL | 回退 SQLite + 本地目录（内网/自建盘） |
| 备份 | Supabase/Neon 自带 PITR 或逻辑备份；也可导出 `harbor_objects` |

## 与 SQLite 对照

| | SQLite | Postgres |
|---|---|---|
| 部署 | 需要磁盘/Volume | 只要连接串 |
| 多实例 | 不行 | 可以 |
| 免费 PaaS | 要 Volume | Supabase/Neon 免费档即可 |
