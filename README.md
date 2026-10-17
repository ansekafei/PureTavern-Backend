# PureTavern Backend (Cloudflare Workers)

PureTavern 的可选远程后端，跑在 Cloudflare Workers 上。它只做一件事：把 Web 前端已经构造好的最终聊天补全请求转发给模型服务商，并把响应（含 SSE 流）原样送回浏览器，用来绕过 CORS。

Provider 的 URL、Headers、Body 构造、认证方式和响应解析全部留在前端。这个后端不知道 OpenAI、Claude、Gemini 长什么样，所以上游新增一家服务商时这里不需要改任何代码。

## 协议

与 [PureTavern](https://github.com/Lianues/PureTavern) 的 `apps/remote-server` 完全一致：

| 端点              | 说明                                                        |
| ----------------- | ----------------------------------------------------------- |
| `GET /v1/health`  | Bearer 鉴权 + 协议握手                                      |
| `POST /v1/proxy`  | 转发一条最终 GET/POST 请求，JSON 与 SSE 都支持              |
| `OPTIONS *`       | CORS 预检                                                   |

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
npm test         # 34 个契约测试
npm run typecheck
```

测试覆盖协议握手、鉴权、CORS、信封校验的 12 类非法输入、SSE 流式透传、hop-by-hop 头剥离、同源/跨域重定向、302 降级 GET、重定向上限、上游 502 与错误状态透传。

## 安全边界

这是一个**能访问任意 HTTP/HTTPS 地址的受保护代理**。生产部署必须：

- 设置高强度 `PURE_TAVERN_PROXY_KEY`，不要用示例值；
- 用 `PURE_TAVERN_ALLOWED_ORIGINS` 限制来源，不要长期裸奔 `*`；
- 只走 HTTPS（Workers 默认就是）；
- 定期轮换密钥。

后端不存储 URL、访问密钥、Provider Key 或请求内容——它没有 KV、D1、R2 绑定，也没有日志落盘。Cloudflare 平台自身会记录请求元数据（时间、状态码、Worker 名），这是平台行为，不是本项目主动收集。

## 已知边界

- **请求体上限**：Workers 免费版单请求 100 MB，本代理的信封上限设为 64 MiB，与上游 Node.js 实现对齐。超长上下文的多模态请求可能触顶。
- **CPU 时间**：免费版单请求 10 ms CPU。纯转发几乎不消耗 CPU，但流式长回复的 wall time 不受此限制（Workers 允许长时间流式响应）。
- **没有重试**：上游 5xx 会原样透传给前端，由前端决定是否重试。这样不会因为代理层重试导致重复计费。
- **不支持 WebSocket**：协议只定义了 HTTP/SSE。

## 目录

```text
src/
  index.ts      Workers 入口：路由、鉴权、CORS、请求体读取
  protocol.ts   协议常量与信封校验
  proxy.ts      上游转发、重定向处理、响应头清洗
  auth.ts       Bearer 鉴权与 CORS 头构造
test/
  worker.test.ts
```

## 许可

AGPL-3.0-only，与上游 PureTavern 一致。
