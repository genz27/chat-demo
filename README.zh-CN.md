# 哈吉咪咪

[English](README.md) | 简体中文

哈吉咪咪是基于 haqimi.uk OpenAI-compatible API 的聊天应用。Docker/Nginx 在服务端注入 API Key，浏览器不再提供 API Key 输入框。

当前仅开放 DeepSeek V4.1 Flash 与 Grok 4.7 两个模型。DeepSeek 请求会自动携带仓库内 `src/services/api/deepseekPrompt.ts` 的默认系统提示词。两种模型都固定使用最高 `xhigh` 思考档位，界面不再显示思考等级选择器。Grok 默认通过 `/v1/responses` 携带 `web_search` 和 `x_search` 工具，无需手动开启；工具是否实际执行由上游决定。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
pnpm install
pnpm dev
```

打开 http://localhost:8090 。生成静态产物：`pnpm build`。

## Docker 部署

复制环境变量模板并填入 haqimi.uk 密钥（不要提交 `.env`）：

```sh
cp .env.example .env
# 编辑 .env，设置 CHAT_API_KEY=... 和 ACCESS_PASSWORD=...
docker compose up --build -d
```

打开 <http://localhost:8080>。密钥只存在容器环境和 Nginx 的请求头中，前端设置页不再显示数据管理/API Key 输入。

网站与全部 `/v1` 接口都需要浏览器登录。默认账号为 `hajimimi`，密码由 `ACCESS_PASSWORD` 环境变量设置，容器启动时生成 bcrypt 密码文件。可以通过 `ACCESS_USERNAME` 更改账号。缺少密码时容器拒绝启动；不要将 `.env` 提交到 Git。公网使用应配置 HTTPS，以免 Basic Auth 凭据通过明文 HTTP 传输。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、停止与符合条件的继续生成；可在输入框选择 DeepSeek 或 Grok。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局和位置设置。

## 数据与配置

部署密钥由 `CHAT_API_KEY` 环境变量提供，不写入仓库；会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源隔离。设置页仅保留主题、语言、朗读音色和位置偏好。

[rspack.config.ts](rspack.config.ts) 默认连接 `https://haqimi.uk`；Docker 使用同源 `/v1` 代理。DeepSeek 使用 `/v1/chat/completions`，Grok 使用 `/v1/responses` 并默认携带 Web/X 搜索工具；语音使用 `/v1/tools/asr` 与 `/v1/tools/tts`。

## 开发

| 命令               | 用途                          |
| ------------------ | ----------------------------- |
| `pnpm dev`         | 启动开发服务器                |
| `pnpm build`       | 构建到 `dist/`                |
| `pnpm type`        | TypeScript 类型检查           |
| `pnpm test:api`    | API 请求及流式响应回归测试    |
| `pnpm test:prompt` | DeepSeek 默认提示词完整性测试 |
| `pnpm lint`        | oxlint 检查                   |
| `pnpm format`      | oxfmt 格式化                  |

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
