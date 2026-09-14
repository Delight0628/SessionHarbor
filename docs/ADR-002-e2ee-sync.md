# ADR-002：E2EE 云同步协议（M3 预备，仅设计）

| 项 | 内容 |
|---|---|
| 状态 | Proposed（2026-09-14，设计稿，未实现） |
| 决策者 | 高国兴 |
| 关联 | 项目开发文档 §5/§6.2/§13；M3 里程碑 |

## 目标

会话 IR 同步到云端时：**服务端零知识**（只见密文）；多设备可解密恢复；可选密文态检索。

## 威胁模型（摘要）

| 不信任 | 信任 |
|---|---|
| 云端存储与运维、传输中间人 | 用户设备与 SessionHarbor 客户端代码 |
| 其他租户 | 用户自己的口令/恢复短语 |

## 协议草案

### 1. 密钥层次

```
用户口令 ──(Argon2id, salt=设备/账户)──► 主密钥 MK
MK ──HKDF──► DEK（数据加密密钥，每会话可再派生）
MK ──HKDF──► MEK（元数据加密密钥：标题/cwd 等可搜索字段）
```

- **客户端产钥，永不上传明文 MK/DEK**
- 恢复：24 词 BIP39 或导出 `harbor.key`（加密文件）

### 2. 密文对象

```
{
  "v": 1,
  "sessionId": "公开 ID（便于路由，不含明文）",
  "nonce": "base64",
  "ct": "base64",          // AES-256-GCM(DEK, IR jsonl)
  "metaCt": "base64",      // AES-256-GCM(MEK, {title, cwd, updatedAt})
  "aad": "sessionId|v"
}
```

算法：**libsodium**（crypto_aead_xchacha20poly1305_ietf）或 WebCrypto AES-GCM。

### 3. 密文态检索（两档，产品分期）

| 档 | 方案 | 体验 | 复杂度 |
|---|---|---|---|
| **A（V2 首选）** | 客户端下载全部 metaCt 解密后本地 FTS | 需拉元数据；正文按需 | 低，零知识保持 |
| **B（远期）** | 可搜索加密（SSE / 加密倒排 + 陷门） | 服务端可代查 | 高，有泄漏模式，需单独 ADR |

**决策：V2 采用 A**；B 不在 M3 范围。

### 4. 同步流程

1. 本地变更 → 加密 → `PUT /v1/sessions/{id}`（If-Match etag 防冲突）
2. 他端拉取列表（仅 id/etag/version）→ 拉 metaCt 解密建本地索引 → 按需拉 ct
3. 冲突：last-writer-wins + 客户端 copy-on-branch 分支会话（与本地 IR 分支策略一致）

### 5. 企业内网版

- 同协议可指向自建对象存储；**密钥可由企业 KMS 托管的可选“托管模式”**（与个人零知识模式数据面隔离）
- 默认仍是零知识；托管需管理员显式开启并审计

## 未决

- 多设备密钥轮换与吊销
- 团队共享：对称 DEK 用成员公钥封装（见团队库 schema 草案）
- 密文去重（同 contentHash 是否上云一份）——隐私 vs 成本

## 参考

- libsodium secretstream / aead
- Signal 双棘轮（若做实时协作再议；同步场景不需要）
- SillyTavern：本地明文，无云同步，不适用本 ADR
