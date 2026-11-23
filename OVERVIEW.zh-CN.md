**语言：** [English](OVERVIEW.md) | 简体中文

# Scripted Provider

**Scripted Provider** 为 [Paseo](https://paseo.sh) 提供确定性、无模型的 Agent 后端（`Scripted`）。支持通过 YAML/JSON 脚本编排回复、流式输出、仅展示型工具调用以及交互式权限/问答卡片；也可在任意真实对话中点击 **录制为脚本**，导出可回放脚本并自动脱敏密钥（`{{secret_N}}`、`{{cwd}}`、`{{email_N}}`）。

## 核心能力

- **零 LLM 调用、零 API Key** — 直接使用内置场景（`chat`、`long-output`、`slow-stream`、`tools-demo`、`fail`、`cancel`、`default`）或自定义 YAML/JSON 脚本。
- **交互式权限与问答卡片** — 确定性测试审批流、自定义按钮、`AskUserQuestion` 问答卡、方案审批卡及并行多卡，绝不在本地磁盘执行任何命令。
- **录制并脱敏真实会话** — 在桌面端/网页端捕获 Claude、Codex 或 OpenCode 真实对话，审查自动脱敏与高熵 Token 后导出 YAML/JSON 或点击 **立即回放**。
- **隔离的 CI 测试套件** — 配套 `paseo-scripted-provider-testkit`，可在 Linux、macOS 和 Windows 上以动态端口和隔离状态拉起真实 Paseo 守护进程。

## 快速开始

1. 新建 Agent 时选择 **Scripted** Provider，并将目标场景作为模型。
2. 发送消息即可逐步推进，或发送 `SCENARIO:<名称>` 在对话中切换场景。
3. 打开 **设置 → Scripted provider** 编辑内联脚本、配置可选的 `received.jsonl` 日志路径及对齐模式（`warn` / `strict` / `ignore`）。

## 可选事件日志与脱敏导出的区别

- **可选事件日志（`received.jsonl`）**：默认关闭，仅在设置中指定路径或设置 `SCRIPTED_PROVIDER_STATE` 时启用。启用后会以 JSONL 格式追加记录入站会话生命周期事件（`open`、`configure`、`close`、`prompt` 文本与附件元数据、`mismatch`、`exhausted`），用于测试断言与调试。日志会省略可能包含凭证的 `env` 与 `mcpServers` 配置（仅记录变量名与服务名），但不会像脚本导出那样对提示词文本运行交互式 `Redactor` 脱敏。
- **脱敏脚本导出（录制为脚本）**：捕获真实对话时间线并通过 `Redactor` 自动识别和替换密钥、高熵 Token、工作目录（`{{cwd}}`）与邮箱（`{{email_N}}`）为确定性占位符，用于导出可安全分享与回放的 YAML/JSON 脚本。
