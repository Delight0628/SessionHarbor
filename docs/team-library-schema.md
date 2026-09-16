# 团队会话库 Schema 草案（M3 预备，仅设计）

| 项 | 内容 |
|---|---|
| 状态 | Draft（2026-09-14） |
| 关联 | ADR-002；开发文档 §5 团队层 |

## 实体

### team
| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | |
| name | string | |
| plan | enum | free / pro / enterprise |
| created_at | timestamptz | |

### team_member
| 字段 | 类型 | 说明 |
|---|---|---|
| team_id | uuid FK | |
| user_id | uuid | |
| role | enum | owner / admin / member / viewer |
| joined_at | timestamptz | |

### shared_session
| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | |
| team_id | uuid FK | |
| source_client | string | 溯源 |
| source_session_id | string | |
| title_ct | bytea | 加密标题 |
| body_blob_id | string | 密文 IR 对象存储 key |
| dek_wrapped | bytea[] | 每成员/角色封装的 DEK |
| tags | text[] | 明文标签（可选，团队约定） |
| visibility | enum | team / project / private_link |
| created_by | uuid | |
| created_at / updated_at | timestamptz | |
| content_hash | char(32) | 去重与完整性 |

### shared_session_audit
| 字段 | 类型 | 说明 |
|---|---|---|
| id | bigserial | |
| session_id | uuid FK | |
| actor_id | uuid | |
| action | enum | share / unshare / view / export / migrate |
| at | timestamptz | |
| detail | jsonb | |

## 权限矩阵（最小）

| 动作 | owner | admin | member | viewer |
|---|---|---|---|---|
| 读会话 | ✓ | ✓ | ✓ | ✓ |
| 写/更新 | ✓ | ✓ | ✓ | |
| 分享给他人 | ✓ | ✓ | ✓ | |
| 取消分享/删除 | ✓ | ✓ | | |
| 导出明文 | ✓ | ✓ | ✓（审计） | |
| 成员管理 | ✓ | ✓ | | |

## 与本地产品关系

- 本地层永久免费；团队库是云订阅团队层功能
- 本地 IR → 加密上云 = `shared_session`；**不改变本地文件格式**
- 检索：成员设备拉取 meta 解密后本地 FTS（与 ADR-002 档 A 一致）

## 部署（可选自建）

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ 桌面客户端   │────▶│ API 网关          │────▶│ PG + 对象存储    │
│ (零知识)     │     │ (可选 KMS)        │     │ (密文)          │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

- 默认不依赖公网；更新可走内网制品库
