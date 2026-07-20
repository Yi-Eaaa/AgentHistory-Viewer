# Agent History

本机 Agent 对话历史浏览服务，首版支持 **Codex** 与 **Claude Code**。

服务只读扫描历史文件，在浏览器中提供统一的会话时间线；收藏数据单独写入项目内的 SQLite，不修改原始对话。

## 功能

- Codex / Claude Code 统一会话列表与数据源筛选
- 来源与工作区筛选、会话标题、模型、消息数、token 与工具调用摘要
- 工具调用和工具结果自动配对、折叠展示
- 全文搜索、会话内搜索、只看提问、隐藏思考过程
- 收藏（SQLite 持久化）、提问大纲跳转
- Markdown / HTML 导出
- 统计仪表盘：token 趋势、最近 16 周活动热力图、模型 Token 用量排行、日/月/年粒度
- 浅色 / 深色主题、桌面和移动端自适应
- 可选 HTTP Basic Auth

## 快速开始

前提：Node.js `>= 22.13.0`（收藏使用 Node 内置 SQLite）。

```bash
npm install
npm run dev
```

打开 [http://127.0.0.1:30100](http://127.0.0.1:30100)。开发命令会同时启动页面和本地历史 API。

### 生产模式

```bash
npm install
npm run build
npm start
```

默认只监听 `127.0.0.1:30100`。可以直接指定其他端口：

```bash
PORT=8080 npm start
```

也可以复制配置模板：

```bash
cp .env.example .env
```

`npm run dev` 与 `npm start` 会自动读取项目根目录的 `.env`，shell 环境变量优先。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 对外监听地址 |
| `PORT` | `30100` | 浏览器访问端口 |
| `CODEX_HISTORY_ROOT` | `~/.codex/sessions` | Codex 历史目录 |
| `CLAUDE_HISTORY_ROOT` | `~/.claude/projects` | Claude Code 历史目录 |
| `AGENT_HISTORY_STATE` | `./state` | 收藏数据库目录 |
| `AGENT_HISTORY_USERNAME` | 空 | Basic Auth 用户名 |
| `AGENT_HISTORY_PASSWORD` | 空 | Basic Auth 密码 |

若要从同一局域网的其他设备访问，请同时配置监听地址和认证：

```bash
HOST=0.0.0.0 PORT=30100 \
AGENT_HISTORY_USERNAME=viewer \
AGENT_HISTORY_PASSWORD='请替换为强密码' \
npm start
```

然后访问 `http://<本机局域网IP>:30100`。

## 数据与隐私

- 原始历史目录只读；重新扫描不会更改 Codex 或 Claude Code 文件。
- 收藏保存在 `state/history.db`，不按 Basic Auth 用户隔离。
- 解析结果只缓存在当前服务进程内，历史文件的大小或修改时间变化后会自动失效。
- 对话里可能包含代码、路径、命令输出和密钥。未配置认证时请保持 `HOST=127.0.0.1`，不要暴露到不可信网络。
- HTTP Basic Auth 不提供传输加密；跨不可信网络访问时应在前面配置 HTTPS 反向代理或使用安全隧道。

## 项目结构

```text
app/                    React 页面与样式
server/
  index.mjs             HTTP API、Basic Auth、页面反向代理
  history-store.mjs     文件扫描、缓存、搜索、收藏、统计、导出
  parsers.mjs           Codex / Claude Code 格式归一化
scripts/run.mjs         同时管理页面和 API 进程
state/                  运行时收藏数据库（git ignored）
tests/                  解析器、存储与页面构建测试
```

## API

- `GET /api/health`：健康检查
- `GET /api/sessions`：会话列表；支持 `source`、`workspace`、`q`、`favorite`、`limit`、`offset`（兼容旧参数 `project`）
- `GET /api/sessions/:source/:id`：完整会话时间线
- `POST /api/refresh`：重新扫描历史目录
- `PUT|DELETE /api/favorites/:source/:id`：添加或移除收藏
- `GET /api/stats`：统计；支持 `source`、`granularity`、`from`、`to`
- `GET /api/export/:source/:id?format=md|html`：导出会话

## 验证

```bash
npm test
npm run lint
npx tsc --noEmit
```
