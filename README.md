# PureTavern Backend (Cloudflare Workers)

PureTavern 的可选远程后端，跑在 Cloudflare Workers 上。它只做一件事：把 Web 前端已经构造好的最终聊天补全请求转发给模型服务商，并把响应（含 SSE 流）原样送回浏览器，用来绕过 CORS。

Provider 的 URL、Headers、Body 构造、认证方式和响应解析全部留在前端。这个后端不知道 OpenAI、Claude、Gemini 长什么样，所以上游新增一家服务商时这里不需要改任何代码。

## 协议

与 [PureTavern](https://github.com/Lianues/PureTavern) 的 `apps/remote-server` 完全一致：

## 端点

| 端点                              | 说明                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `GET /v1/health`  | Bearer 鉴权 + 协议握手                                      |
| `POST /v1/proxy`  | 转发一条最终 GET/POST 请求，JSON 与 SSE 都支持              |
| `OPTIONS *`       | CORS 预检                                                   |
| `/v1/sync/*`      | 可选：端到端加密的多设备数据同步保险库（见下文）             |

- 协议名：`pure-tavern-generation-proxy`，版本 `1`
- 鉴权：`Authorization: Bearer <PURE_TAVERN_PROXY_KEY>`，恒定时间比较
- 信封上限：64 MiB
- 重定向：最多 10 跳，跨域重定向自动丢弃 `Authorization` / `Cookie`

## 部署

```bash
npm install

# 1. 设置访问密钥（不会写进仓库）
npx wrangler secret put PURE_TAVERN_PROXY_KEY

# 2. 部署
npx wrangler deploy
```

部署完会拿到一个 `https://pure-tavern-backend.<你的子域>.workers.dev` 地址。在 PureTavern 的「连接管理 → 传输方式 → 远程后端调用」里填这个地址和刚才的密钥，点连接即可。

生成一个够强的密钥：

```bash
openssl rand -base64 48
```

### 限制允许的来源

默认接受任意 Origin。生产环境建议收紧 `wrangler.toml`：

```toml
[vars]
PURE_TAVERN_ALLOWED_ORIGINS = "https://pure-tavern.pages.dev,https://tavern.example.com"
```

留空或写 `*` 表示不限。

### 自定义域名

Workers 默认域名在国内访问不稳定。有域名的话在 `wrangler.toml` 里加：

```toml
routes = [
  { pattern = "tavern-api.example.com", custom_domain = true }
]
```

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入本地用的密钥
npm run dev                      # 默认 http://127.0.0.1:8787
```

## 验证

```bash
npm test         # 50 个契约测试
npm run typecheck
```

测试覆盖协议握手、鉴权、CORS、信封校验的 12 类非法输入、SSE 流式透传、hop-by-hop 头剥离、同源/跨域重定向、302 降级 GET、重定向上限、上游 502 与错误状态透传；同步保险库部分覆盖注册/重复注册/大小写归一、错误密码、未知账号与错误密码响应一致、无 token 拒绝、异密钥签名拒绝、索引与对象读写删、双账号隔离、对象 id 越权校验、CORS PUT/DELETE 仅在 sync 路由开放。

## 安全边界

这是一个**能访问任意 HTTP/HTTPS 地址的受保护代理**。生产部署必须：

- 设置高强度 `PURE_TAVERN_PROXY_KEY`，不要用示例值；
- 用 `PURE_TAVERN_ALLOWED_ORIGINS` 限制来源，不要长期裸奔 `*`；
- 只走 HTTPS（Workers 默认就是）；
- 定期轮换密钥。

后端不存储 URL、访问密钥、Provider Key 或请求内容——代理这条路径没有 KV、D1、R2 绑定，也没有日志落盘。Cloudflare 平台自身会记录请求元数据（时间、状态码、Worker 名），这是平台行为，不是本项目主动收集。

唯一的持久化是下面这套同步保险库，且它存的全部是密文。

## 同步保险库（可选）

多设备之间共享备份用的端到端加密存储。**服务器拿不到明文**——加密密钥由你在浏览器里输入的同步密码派生，从不出设备。

### 为什么这样设计

需求是「换个设备能接着用我的数据」+「别人别想读我的数据」。所以：

- 密码**不用来登录**，用来**派生密钥**；
- 服务器只存一个验证哈希（证明你确实知道密码）和密文；
- R2 桶泄露、Worker 被攻破、Cloudflare 内部看到——都只能拿到一堆随机字节。

### 密钥派生

浏览器端一次 PBKDF2-SHA256（600,000 轮，64 字节输出）：

```text
salt        = SHA-256("pure-tavern-sync-salt:v1:" + lowercase(username))
derived     = PBKDF2-SHA256(password, salt, 600000, 64 bytes)
aesKey      = derived[0..32]                       → AES-256-GCM，永不上传
authHash    = SHA-256(derived[32..64]) → 上传       → 服务器再存一层 SHA-256
```

服务器存的是 `SHA-256(authHash)`，所以即便 R2 泄露，攻击者也拿不到能登录的凭据（更拿不到解密密钥）。

### 存储布局（R2 桶 `pure-tavern-sync`）

```text
auth/{accountId}.json          → { accountId, username, verifier, createdAt }
user/{accountId}/index.enc     → 加密后的备份索引
user/{accountId}/obj/{id}.enc  → 加密后的归档二进制
```

`accountId = SHA-256("pure-tavern-sync-account:v1:" + username)`。用户名不出现在路径里，未知用户名扫不到别人的命名空间。

### 接口

| 方法 + 路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /v1/sync/register` | 无 | `{username, verifier}` → `{token, accountId}`，用户名被占用返 409 |
| `POST /v1/sync/login` | 无 | `{username, verifier}` → `{token, accountId}`，错误一律 401（不做用户名探测） |
| `GET /v1/sync/index` | Token | 取索引密文，没有则 404 |
| `PUT /v1/sync/index` | Token | 覆盖索引密文 |
| `GET /v1/sync/objects/{id}` | Token | 取归档密文 |
| `PUT /v1/sync/objects/{id}` | Token | 存归档密文（单对象 ≤ 100 MB） |
| `DELETE /v1/sync/objects/{id}` | Token | 删除，不存在返 404 |

Token 是 HMAC-SHA256 签名的 `v1.{payload}.{sig}`，默认 30 天有效。轮换 `PURE_TAVERN_SYNC_SECRET` 会让所有设备立即登出，但不动已存的密文。

### 启用

```bash
# 1. 建桶（也可以在 Cloudflare 后台点）
npx wrangler r2 bucket create pure-tavern-sync

# 2. 绑定已写在 wrangler.toml 的 [[r2_buckets]] 里，无需改

# 3. 会话签名密钥
npx wrangler secret put PURE_TAVERN_SYNC_SECRET

# 4. 部署
npx wrangler deploy
```

不配置 `PURE_TAVERN_SYNC_SECRET` 时 `/v1/sync/*` 返回 500 `sync-not-configured`，代理路径不受影响。

### 这**不是**实时同步

它做的是「多设备共享一个备份库」：每台设备上传的是完整快照，恢复时你自己挑一个。没有做双向合并（那需要 CRDT 或版本向量，是另一个量级的工作）。

冲突处理靠人工：两台设备各自上传，`index.enc` 里保存所有快照的元数据，恢复时选最新的那个。**上传不会自动覆盖别人的数据**，只会覆盖同 id 的对象。

## 已知边界

- **请求体上限**：Workers 免费版单请求 100 MB，本代理的信封上限设为 64 MiB，与上游 Node.js 实现对齐。超长上下文的多模态请求可能触顶。
- **CPU 时间**：免费版单请求 10 ms CPU。纯转发几乎不消耗 CPU，但流式长回复的 wall time 不受此限制（Workers 允许长时间流式响应）。
- **没有重试**：上游 5xx 会原样透传给前端，由前端决定是否重试。这样不会因为代理层重试导致重复计费。
- **不支持 WebSocket**：协议只定义了 HTTP/SSE。

## 目录

```text
src/
  index.ts        Workers 入口：路由、鉴权、CORS、请求体读取
  protocol.ts     协议常量与信封校验
  proxy.ts        上游转发、重定向处理、响应头清洗
  auth.ts         Bearer 鉴权与 CORS 头构造
  sync/
    routes.ts     /v1/sync/* 七个端点
    store.ts      R2 布局、账号原子创建、对象 id 校验
    token.ts      HMAC-SHA256 会话 token 签发与校验
test/
  worker.test.ts  代理契约
  sync.test.ts    同步保险库契约
  fake-r2.ts      测试用的内存 R2 替身
```

## 许可

AGPL-3.0-only，与上游 PureTavern 一致。
