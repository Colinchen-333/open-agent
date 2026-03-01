<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="MIT License" />
  <img src="https://img.shields.io/badge/tests-542%20passing-22c55e?style=for-the-badge" alt="Tests" />
</p>

<h1 align="center">Open Agent</h1>

<p align="center">
  <strong>开源 AI 编程智能体框架，提供 CLI 与 SDK</strong><br/>
  多模型供应商 · 28 个内置工具 · 多智能体协作 · MCP 集成
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#sdk-使用">SDK 使用</a> ·
  <a href="#架构">架构</a> ·
  <a href="#工具">工具</a> ·
  <a href="#配置">配置</a>
</p>

---

## 概述

Open Agent 是一个功能完整的 AI 编程智能体框架，基于 **Bun** 和 **TypeScript** 构建。它提供了**交互式 CLI**（用于日常编码）和**编程 SDK**（用于将 AI 编码能力嵌入任何应用）。

### 为什么选择 Open Agent？

- **完全开源** — 从上到下全部开源，无厂商锁定。
- **多模型支持** — Anthropic（扩展思考 & Prompt 缓存）、OpenAI 兼容 API、Ollama（本地模型）。
- **28 个内置工具** — 文件读写、Shell 执行、代码搜索、网页抓取、Notebook 编辑、Git Worktree 等。
- **多智能体协作** — 可并行启动子智能体，支持共享任务看板和智能体间消息通信。
- **MCP 集成** — 一流的 Model Context Protocol 支持（stdio / HTTP / SSE 传输协议）。
- **权限系统** — 5 种权限模式，从交互审批到完全放行。
- **会话持久化** — 通过 JSONL 记录恢复跨重启的对话。
- **Hook 系统** — 生命周期钩子，覆盖 `PreToolUse`、`PostToolUse`、`SessionStart` 等 15+ 事件。
- **扩展思考** — 自适应和显式思考模式，支持可配置的 token 预算。

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) v1.1+
- 来自 Anthropic、OpenAI 或任何兼容供应商的 API Key

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/Colinchen-333/open-agent.git
cd open-agent

# 安装依赖
bun install

# 设置 API Key
export ANTHROPIC_API_KEY="sk-ant-..."
# 或者使用 OpenAI 兼容的供应商：
export OPENAI_API_KEY="your-key"
export OPENAI_BASE_URL="https://api.example.com/v1"

# 启动交互式 CLI
bun run start

# 或者构建独立二进制文件
bun run build
./apps/cli/open-agent
```

### CLI 用法

```bash
# 交互模式
open-agent

# 单次提问
open-agent "解释一下这个代码库"
open-agent -p "修复 auth.ts 中的 bug"

# 指定模型
open-agent -m claude-opus-4-6 "review 这个 PR"

# 恢复上次会话
open-agent --continue
open-agent --resume <session-id>

# 其他选项
#   --add-dir <path>        添加额外工作目录（可重复使用）
#   --verbose, --debug      启用详细/调试输出
#   --permission-prompt-tool <name>  用于权限决策的 MCP 工具
```

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/model [name]` | 查看或切换当前模型 |
| `/compact` | 压缩对话历史以节省上下文 |
| `/cost` | 显示当前会话的 token 用量和费用 |
| `/tools` | 列出所有已注册的工具 |
| `/status` | 显示会话状态 |
| `/memory` | 内存状态 |
| `/clear` | 清屏 |
| `/exit` | 退出会话 |

## SDK 使用

### 流式查询（V1 API）

```typescript
import { query } from '@open-agent/sdk';

const stream = query('查找并修复 src/ 目录下的所有 TypeScript 错误', {
  model: 'claude-sonnet-4-6',
  cwd: '/path/to/project',
  permissionMode: 'acceptEdits',
  maxTurns: 10,
});

for await (const event of stream) {
  switch (event.type) {
    case 'assistant':
      console.log('助手:', event.message);
      break;
    case 'tool_result':
      console.log(`[${event.tool_name}]`, event.result);
      break;
    case 'result':
      console.log(`完成，共 ${event.num_turns} 轮，费用: $${event.total_cost_usd}`);
      break;
  }
}
```

### 直接指定供应商

```typescript
import { query } from '@open-agent/sdk';

// 直接使用任何 OpenAI 兼容的端点
const stream = query('解释这段代码', {
  provider: 'openai',
  apiKey: 'your-api-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'your-model-name',
});

for await (const event of stream) {
  if (event.type === 'result') console.log('完成:', event.num_turns, '轮');
}
```

### 备用模型与预算控制

```typescript
import { query } from '@open-agent/sdk';

const stream = query('重构 auth 模块', {
  model: 'claude-opus-4-6',
  fallbackModel: 'claude-sonnet-4-6',  // 模型出错时自动切换
  maxBudgetUsd: 5.00,                   // 费用硬上限
  maxTurns: 20,
});

for await (const event of stream) {
  if (event.type === 'result') {
    console.log(`费用: $${event.total_cost_usd}, 轮次: ${event.num_turns}`);
  }
}
```

### 有状态会话（V2 API）

```typescript
import { createSession, resumeSession } from '@open-agent/sdk';

// 创建多轮会话
const session = createSession({
  model: 'claude-opus-4-6',
  thinking: { type: 'enabled', budgetTokens: 16000 },
  persistSession: true,
});

// 第一轮
for await (const msg of session.send('分析数据库 schema')) {
  // 处理消息...
}

// 第二轮 — 完整上下文保留
for await (const msg of session.send('给 users.email 添加索引')) {
  // 处理消息...
}

const id = session.sessionId;
session.close();

// 稍后恢复 — 甚至可以从另一个进程
const restored = resumeSession(id, { model: 'claude-sonnet-4-6' });
for await (const msg of restored.send('我们上次改了什么？')) {
  // 完整历史可用
}
```

### 自定义 MCP 工具

```typescript
import { query, createSdkMcpServer, tool } from '@open-agent/sdk';

const server = createSdkMcpServer({
  name: 'deploy-tools',
  tools: [
    tool('deploy', '部署到生产环境', {
      type: 'object',
      properties: {
        branch: { type: 'string', description: '要部署的 Git 分支' },
        env: { type: 'string', enum: ['staging', 'production'] },
      },
      required: ['branch', 'env'],
    }, async (input) => {
      // 你的部署逻辑
      return `已将 ${input.branch} 部署到 ${input.env}`;
    }),
  ],
});

const stream = query('将 main 分支部署到 staging', {
  mcpServers: { deploy: server },
});
```

### 多智能体协作

```typescript
import { query } from '@open-agent/sdk';

// 启动子智能体进行并行研究
const stream = query('研究代码库架构，然后重构 auth 模块', {
  model: 'claude-sonnet-4-6',
  permissionMode: 'acceptEdits',
  agents: {
    'researcher': {
      description: '探索并记录代码架构',
      prompt: '你是一个代码研究专家。',
      tools: ['Read', 'Glob', 'Grep'],
    },
  },
});

for await (const event of stream) {
  // 主智能体可以通过 Task 工具启动 'researcher' 子智能体
  if (event.type === 'result') console.log('完成');
}
```

### QueryOptions 参考

```typescript
interface QueryOptions {
  // 模型
  model?: string;                    // LLM 模型标识符
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: ThinkingConfig;         // { type: 'adaptive' | 'enabled' | 'disabled' }
  maxThinkingTokens?: number;

  // 执行
  cwd?: string;                      // 工作目录
  maxTurns?: number;                 // 最大对话轮次
  maxBudgetUsd?: number;             // 费用上限
  abortController?: AbortController; // 取消支持
  additionalDirectories?: string[];  // 额外工作目录
  fallbackModel?: string;            // 主模型失败时使用的备用模型

  // 工具与权限
  tools?: string[];                  // 工具白名单
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;   // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
  allowDangerouslySkipPermissions?: boolean;

  // 会话
  sessionId?: string;
  resume?: string;                   // 从某个 session ID 恢复
  persistSession?: boolean;

  // 扩展
  systemPrompt?: string;
  hooks?: Partial<Record<HookEvent, any[]>>;
  mcpServers?: Record<string, McpServerConfig>;
  agents?: Record<string, AgentDefinition>;
  debug?: boolean;                   // 启用调试日志
  env?: Record<string, string>;      // 环境变量覆盖
  provider?: 'anthropic' | 'openai' | 'ollama';
  apiKey?: string;                   // 供应商 API Key
  baseUrl?: string;                  // 自定义 Base URL
}
```

## 架构

### Monorepo 结构

```
open-agent/
├── apps/
│   └── cli/                # 交互式终端应用
├── packages/
│   ├── sdk/                # 公共 SDK — query()、createSession()、MCP 辅助函数
│   ├── core/               # ConversationLoop、SessionManager、SystemPrompt
│   ├── providers/          # LLM 供应商（Anthropic、OpenAI、Ollama）
│   ├── tools/              # 28 个内置工具实现
│   ├── agents/             # AgentRunner、TeamManager、TaskManager
│   ├── permissions/        # 5 种模式的权限引擎
│   ├── hooks/              # 生命周期钩子执行器
│   ├── mcp/               # MCP 客户端（stdio、HTTP、SSE 传输协议）
│   ├── cli/                # 终端渲染器、输入处理、主题
│   └── plugins/            # 插件系统
├── examples/               # AGENT.md 和 settings.json 模板
```

### 数据流

```
用户输入
    │
    ▼
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│  CLI /   │───▶│   对话循环    │───▶│  LLM 供应商   │──▶ Anthropic / OpenAI / Ollama
│   SDK    │    │              │    │  （流式输出）   │
└──────────┘    └──────┬───────┘    └──────────────┘
                       │
                       ▼
                ┌──────────────┐
                │   权限引擎    │──▶ 允许 / 拒绝 / 询问
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │  工具执行     │──▶ Read, Write, Edit, Bash, Glob, Grep ...
                │   + Hooks    │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │  会话管理器   │──▶ JSONL 记录持久化
                └──────────────┘
```

### 包依赖关系

```
@open-agent/sdk
    ├── @open-agent/core
    │     ├── @open-agent/providers    (Anthropic, OpenAI, Ollama)
    │     └── @open-agent/tools        (28 个内置工具)
    ├── @open-agent/agents             (多智能体协作)
    ├── @open-agent/permissions        (5 种权限模式)
    ├── @open-agent/hooks              (生命周期事件)
    └── @open-agent/mcp               (MCP stdio / HTTP / SSE)
```

## 工具

### 文件操作

| 工具 | 说明 |
|------|------|
| `Read` | 读取文件，支持行号、二进制检测、PDF / 图片 / Notebook |
| `Write` | 创建或覆盖文件 |
| `Edit` | 精确字符串替换并生成 diff |
| `NotebookEdit` | 编辑 Jupyter Notebook 单元格（替换、插入、删除） |

### Shell 与搜索

| 工具 | 说明 |
|------|------|
| `Bash` | Shell 命令执行，支持超时、后台任务、中止信号传播 |
| `Glob` | 快速文件模式匹配（`**/*.ts`、`src/**/*.test.*`） |
| `Grep` | 基于 Ripgrep 的内容搜索，支持正则、上下文行、多行模式 |

### 网络

| 工具 | 说明 |
|------|------|
| `WebFetch` | 抓取并处理 URL，带 15 分钟 LRU 缓存和重定向循环保护 |
| `WebSearch` | 网络搜索，支持域名过滤 |

### 智能体协作

| 工具 | 说明 |
|------|------|
| `Task` | 启动专业子智能体（探索、规划、代码编写等） |
| `TeamCreate` / `TeamDelete` | 创建和管理多智能体团队 |
| `SendMessage` | 智能体间消息 — 私信、广播、关闭请求 |
| `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` | 共享任务列表，用于团队协调 |
| `TaskOutput` / `TaskStop` | 监控和控制后台任务 |

### 规划与工作流

| 工具 | 说明 |
|------|------|
| `EnterPlanMode` / `ExitPlanMode` | 先规划后执行的工作流，需用户审批 |
| `EnterWorktree` | 隔离的 Git Worktree，用于安全、可回滚的变更 |
| `AskUserQuestion` | 结构化多选问题，支持可选预览 |
| `ToolSearch` | 按需发现和加载延迟的 MCP 工具 |
| `Skill` | 调用已注册的斜杠命令工作流 |
| `Config` | 读写智能体配置 |
| `ListMcpResources` / `ReadMcpResource` | 浏览和读取 MCP 服务器资源 |

## 供应商

### Anthropic

```typescript
import { AnthropicProvider } from '@open-agent/providers';

const provider = new AnthropicProvider({
  apiKey: 'sk-ant-...',
});
```

**特性：** 流式输出、扩展思考（自适应/显式）、Prompt 缓存（系统提示 + 工具）、视觉理解、交错思考块、`redacted_thinking` 透传。

### OpenAI 兼容

```typescript
import { OpenAIProvider } from '@open-agent/providers';

const provider = new OpenAIProvider({
  apiKey: 'your-key',
  baseURL: 'https://api.openai.com/v1',
});
```

**兼容：** OpenAI、Azure OpenAI、DeepSeek、Qwen（通义千问）、GLM（智谱）、vLLM、LiteLLM，以及任何 OpenAI 兼容的端点。

### Ollama

```typescript
import { OllamaProvider } from '@open-agent/providers';

const provider = new OllamaProvider({
  baseURL: 'http://localhost:11434',
});
```

**本地运行模型**，零 API 费用。

## 配置

### 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `OPENAI_API_KEY` | OpenAI（或兼容）API Key |
| `OPENAI_BASE_URL` | OpenAI 兼容供应商的自定义端点 |
| `BRAVE_SEARCH_API_KEY` | Brave Search API Key（用于 `WebSearch` 工具） |

### 配置文件

| 路径 | 用途 |
|------|------|
| `~/.open-agent/settings.json` | 全局用户设置 |
| `<项目>/.open-agent/settings.json` | 项目级设置 |
| `<项目>/.open-agent/settings.local.json` | 本地覆盖（已 gitignore） |
| `AGENT.md` | 项目自定义指令（根目录或 `.open-agent/` 下） |
| `~/.open-agent/hooks.json` | 全局钩子定义 |

配置示例（`examples/settings.json`）：

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "permissionMode": "default",
  "effort": "high",
  "thinking": "adaptive",
  "maxTurns": 50,
  "mcpServers": {},
  "customInstructions": ""
}
```

### 权限模式

| 模式 | 行为 |
|------|------|
| `default` | 危险操作（Shell、文件写入、网络）时询问用户 |
| `acceptEdits` | 自动允许文件编辑，Shell 命令仍需询问 |
| `bypassPermissions` | 允许所有操作，不提示 |
| `plan` | 只读探索，任何变更前需用户审批 |
| `dontAsk` | 拒绝所有需要用户审批的操作 |

### 思考配置

```typescript
// 自适应 — 模型自行决定何时深入思考
{ thinking: { type: 'adaptive' } }

// 显式 — 固定思考预算
{ thinking: { type: 'enabled', budgetTokens: 16000 } }

// 力度预设 — 自动映射到思考预算
{ effort: 'low' }    // 2,000 tokens
{ effort: 'medium' } // 8,000 tokens
{ effort: 'high' }   // 16,000 tokens
{ effort: 'max' }    // 32,000 tokens
```

### Hooks

创建 `.open-agent/hooks.json` 以在生命周期事件上运行命令：

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "command": "echo '即将执行 Shell 命令'" }]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [{ "command": "logger -t open-agent '工具已执行'" }]
    }
  ]
}
```

**支持的事件：** `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`SessionStart`、`SessionEnd`、`Stop`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PermissionRequest`、`Setup`、`UserPromptSubmit`、`Notification`、`TeammateIdle`、`TaskCompleted`、`ConfigChange`、`WorktreeCreate`、`WorktreeRemove`

### MCP 服务器

在 `.open-agent/settings.json` 中添加 MCP 服务器：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "remote-api": {
      "type": "http",
      "url": "https://mcp.example.com/api",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

## 开发

```bash
# 安装依赖
bun install

# 以开发模式运行 CLI
bun run dev

# 运行所有测试
bun test

# 类型检查
bun run typecheck

# 构建所有包
bun run build
```

### 项目统计

| 指标 | 数值 |
|------|------|
| TypeScript 源码 | ~17,200 行，79 个文件 |
| 包数量 | 10 |
| 内置工具 | 28 |
| LLM 供应商 | 3（Anthropic、OpenAI、Ollama） |
| 测试文件 | 28 |
| 测试用例 | 542 通过 |

## 许可证

[MIT](LICENSE) © Colin Chen
