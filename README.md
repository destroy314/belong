# 物归（Belong）

一个可运行的微信小程序 MVP，用自然语言让家庭成员共同查询和维护物品位置。

## 架构

- **客户端**：原生微信小程序 TypeScript + WXML + Less，无 UI 框架、无 tabBar。
- **服务端**：Node.js 单体 HTTP 服务，只使用 Node 内建 SQLite 和文件系统；运行时无第三方依赖。
- **库存**：每个家庭只有一个 `inventory.md`，它是物品数据的唯一事实来源。SQLite 只保存用户、会话、家庭、成员、LLM 配置和当天对话。
- **Agent**：每次聊天把完整库存的临时 Hashline 视图、系统提示和当天近期对话发给 OpenAI-compatible Chat Completions API。模型只能直接回复或调用 `edit_inventory`。
- **并发**：库存内容的 SHA-256 是版本号。编辑先校验版本和全部短哈希，再通过临时文件 `fsync + rename` 原子写入；冲突时 Agent 重新读取最新库存并重试。

主要代码：

```text
miniprogram/
  pages/index/       对话主页
  pages/inventory/   Markdown 库存浏览与搜索
  pages/family/      家庭、成员和模型设置
server/src/
  agent.ts           极简 Agent 循环
  prompt.ts          系统提示和唯一工具定义
  hashline.ts        Hashline 视图与原子编辑
  inventory.ts       Markdown 解析和文件存储
  db.ts              SQLite 元数据
  api.ts             HTTP API
  llm.ts             OpenAI-compatible 薄适配层
```

## 本地运行

要求 Node.js 24+ 和微信开发者工具。

### 1. 配置并启动后端

仓库中的 `server/.env` 已可用于本地调试。新环境可从示例创建：

```bash
cd server
cp .env.example .env
npm install
npm run dev
```

服务默认监听 `http://127.0.0.1:3000`，健康检查为：

```bash
curl http://127.0.0.1:3000/health
```

开发模式下如果没有微信 AppID/Secret，`DEV_WECHAT_LOGIN=true` 会把 `wx.login` code 不可逆地映射为本地测试身份；生产环境不会启用此行为。

### 2. 打开小程序

用微信开发者工具导入仓库根目录。小程序本地 API 地址在 `miniprogram/config.ts` 中配置：

```ts
export const API_BASE_URL = 'http://127.0.0.1:3000/api'
```

本机开发已在 `project.private.config.json` 关闭请求域名校验。真机或生产发布时，把地址改为 HTTPS 域名，并在微信公众平台配置 request 合法域名。

### 3. 首次使用

1. 在“家庭”页创建家庭，或输入邀请码加入。
2. 若后端 `.env` 配置了默认 LLM，创建后即可聊天。
3. 家庭创建者/管理员也可在“模型服务”中保存家庭自己的 API 地址、模型和 API Key。密钥不会被重新返回。

### 4. 创建可联调的开发家庭

后端 `.env` 已填写 `LLM_BASE_URL`、`LLM_MODEL` 和 `LLM_API_KEY` 时，运行：

```bash
npm run dev:create-family
```

该命令仅可在开发环境执行。它会创建一个本地开发者账号和家庭，配置 LLM 和 API Key，并写入示例物品。

## 环境变量

完整示例见 `server/.env.example`。常用配置：

| 变量 | 说明 |
| --- | --- |
| `LLM_BASE_URL` | OpenAI-compatible API 根地址或 `/v1` 地址 |
| `LLM_MODEL` | 模型名称 |
| `LLM_API_KEY` | 未配置家庭 BYOK 时使用的服务端默认密钥 |
| `WX_APP_ID` / `WX_APP_SECRET` | 生产微信登录凭据 |
| `BYOK_ENCRYPTION_KEY` | 32 字节 Base64 或 64 位 hex 主密钥；生产必填 |
| `DATA_DIR` | SQLite 和库存文件目录，默认 `server/data` |
| `DAY_TIMEZONE_OFFSET_MINUTES` | 会话时区偏移，默认 `480`（UTC+8） |
| `DAY_BOUNDARY_HOUR` | 会话日界线小时，默认 `4`（凌晨四点） |
| `CHAT_HISTORY_LIMIT` | 每次提供给模型的当天近期消息数，默认 20 |

可用 `openssl rand -base64 32` 生成生产加密主密钥。本地缺少主密钥时，服务会在数据目录生成权限为 `0600` 的持久化密钥；生产环境缺少主密钥、微信 AppID 或 Secret 时会拒绝启动。

## 数据与安全

默认数据布局：

```text
server/data/
  belong.sqlite
  .byok-master-key
  families/<family-id>/inventory.md
```

- `inventory.md` 不写入数据库，也不保存编辑历史或检查点。
- 家庭 API Key 使用 AES-256-GCM，并以家庭 ID 作为附加认证数据；读取接口只返回 `hasApiKey`。
- 登录 bearer token 只以 SHA-256 摘要保存。
- 服务不记录请求体、Authorization 或 API Key。
- 当天对话按用户和家庭读取；旧消息在请求时及每天 UTC+8 凌晨四点后物理删除。小程序本地展示缓存也按同一会话日分隔。开发版可在聊天页手动重置当前用户的会话，用于联调；该接口在生产环境不可用。

## API

除登录外均需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/auth/wechat` | 微信 code 登录 |
| `PUT` | `/api/users/me` | 修改当前用户昵称和头像 |
| `GET/POST` | `/api/families` | 列出/创建家庭 |
| `POST` | `/api/families/join` | 邀请码加入 |
| `GET` | `/api/families/:id/inventory` | 读取 Markdown 和版本 |
| `GET` | `/api/families/:id/members` | 查看成员 |
| `DELETE` | `/api/families/:id/members/me` | 当前成员退出家庭（创建者除外） |
| `DELETE` | `/api/families/:id/members/:userId` | 创建者移除成员 |
| `DELETE` | `/api/families/:id` | 创建者删除家庭及其库存 |
| `GET/PUT` | `/api/families/:id/llm-config` | 查看状态/保存 BYOK |
| `POST` | `/api/families/:id/chat` | 查询或修改库存 |

## 测试与构建

```bash
# 小程序 TypeScript
npm install
npm run typecheck

# 后端
cd server
npm run build
npm test
# 本地运行仍用 npm run dev；配置完生产变量后用 npm start
```

测试覆盖 Markdown 解析、重复行哈希、插入/替换/删除、失效哈希、版本冲突、并发写入、SQLite 元数据、会话令牌、BYOK、日界线，以及中文自然语言添加/移动/修改/删除到真实 Markdown 文件的完整编辑链路。

生产部署保持单进程/单副本，并为 `DATA_DIR` 挂载持久磁盘；这是当前文件锁和 SQLite 设计的运行边界。由反向代理提供 HTTPS，不要把 `server/.env` 或数据目录提交到版本控制。
