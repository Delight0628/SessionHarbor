# Railway 部署 SessionHarbor Cloud

## 你需要准备

1. 已登录 https://railway.app  
2. （可选）Account Token：Workspace → Settings → Tokens  
3. 项目名，例如 `sessionharbor-cloud`  
4. 强随机 `HARBOR_CLOUD_ADMIN_TOKEN`  
5. 邮箱通道：内网用 `console`；公网建议 webhook  

## 本地先构建 dist

```powershell
.\scripts\build.ps1
# 确保存在:
#   packages/core/dist/**
#   packages/cloud-server/dist/**
```

## 方式 A：网页（无需 Token）

1. Railway → **New Project** → **Deploy from GitHub repo**（推到 GitHub 后）  
   或 **Empty Project** → 上传/用 CLI  
2. Root Directory 填 `packages/cloud-server`（若用 Dockerfile.railway，Context 设仓库根）  
3. Build → 选 Dockerfile：`packages/cloud-server/Dockerfile.railway`  
4. **Volumes**：Mount Path = `/data`  
5. Variables：

```text
HARBOR_CLOUD_DATA=/data
HARBOR_CLOUD_ADMIN_TOKEN=<你的强随机串>
HARBOR_CLOUD_MAIL=console
HARBOR_CLOUD_REQUIRE_EMAIL_VERIFY=1
PORT=8080
```

6. Settings → Networking → Generate Domain  
7. 健康检查：`/healthz`  

## 方式 B：Railway CLI

```powershell
npm i -g @railway/cli
railway login
railway init
railway volume add -m /data
railway variables set HARBOR_CLOUD_DATA=/data HARBOR_CLOUD_ADMIN_TOKEN=xxx HARBOR_CLOUD_MAIL=console PORT=8080
# 在 packages/cloud-server 下指定 Dockerfile.railway 后
railway up
```

## 客户端

```powershell
harbor register --email you@x.com --password ****** --endpoint https://<你的域名>
harbor login    --email you@x.com --password ****** --endpoint https://<你的域名>
harbor sync push session --id <uuid>
```

## 注意

- **必须挂 Volume**，否则重部署丢库  
- **Num Replicas = 1**（SQLite）  
- 定期备份 `/data`（可用仓库内 backup 脚本逻辑拉到本地）  
