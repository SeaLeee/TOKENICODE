## [15:20] - 功能实现: 接通会话图片多模态输入

- **文件**: src-tauri/src/commands/claude_process.rs, src-tauri/src/lib.rs, src/lib/tauri-bridge.ts, src/components/chat/InputBar.tsx, src/hooks/useStreamProcessor.ts, src/stores/chatStore.ts, src/__tests__/stdin-route-regressions.test.ts
- **决策**: 图片路径由 Rust 读取并编码为 Claude stream-json base64 image content block；路径文本继续保留；覆盖首发、追问、前后台排队消息和仅图片发送。
- **验证**: 前端生产构建通过；stdin 路由测试 14/14；多模态 Rust 测试 2/2；编辑器诊断 0。Rust 全量 56/58，2 个既有 Windows 路径解码测试失败，与本次改动无关。

## [15:32] - Bug 修复: Claude Agent 启动卡死与孤儿进程

- **文件**: src-tauri/src/lib.rs
- **决策**: Claude Code 2.1.237 的 stream-json 输入增加必需的 `--print`；Windows kill 分支使用 `taskkill /T /F` 结束 cmd 包装器及 claude.exe 整棵进程树。
- **验证**: 真实 base64 PNG stream-json 请求收到 system:init 并返回 OK；相关 Rust 测试 3/3；应用 PID 14416 正常运行；已结束会话无 TOKENICODE Claude 孤儿进程。

## [16:03] - Bug 修复: 隔离不可达 MCP 导致的 90 秒启动等待

- **文件**: src-tauri/src/lib.rs, src/components/chat/InputBar.tsx, src/__tests__/stdin-route-regressions.test.ts
- **决策**: 从 Claude 共享配置识别 CCswitch 第三方端点；过滤端口未监听的本机 HTTP/SSE MCP；视觉图片不再重复追加为路径文本；首条消息提交后立即进入 thinking 状态。
- **验证**: 故障 MCP 存在时 `time_to_request_ms=85647`；隔离后为 85ms、总响应 3.9s。Rust provider 测试 8/8、多模态测试 3/3、前端回归 14/14、TypeScript 与编辑器诊断通过。DeepSeek 两种 API 格式均把真实截图替换为 `[Unsupported Image]`，当前模型端不具备可用视觉输入。

## [16:14] - 功能实现: CCswitch DeepSeek 按图片回合切换模型

- **文件**: src-tauri/src/lib.rs, src/lib/tauri-bridge.ts, src/components/chat/InputBar.tsx, src/hooks/useStreamProcessor.ts, src/__tests__/stdin-route-regressions.test.ts, C:/Users/admin/.claude/settings.json
- **决策**: CCswitch 默认模型保持 `deepseek-v4-pro`；仅图片附件或独立图片路径回合使用 `deepseek-v4-flash-vision-exp`，后续纯文本回合通过 CLI `set_model` 自动切回 Pro；非 DeepSeek 地址和 TOKENICODE 内置 provider 不参与该路由。
- **验证**: Rust 多模态与路由测试 5/5，前端 stdin 回归 14/14，TypeScript 与编辑器诊断通过；真实 CLI 双回合验证中 vision 正确识别 TOKENICODE 截图及聊天面板/文件树，随后纯文本回合返回 `PRO_OK`；应用 PID 25696 正常运行。

## [16:24] - Bug 修复: 识别正文内嵌的多个图片路径

- **文件**: src-tauri/src/lib.rs
- **决策**: 图片路径提取从“整行路径”扩展为扫描正文中的真实绝对路径，支持编号长段落、中文目录、空格和同段多图；图片消息显式要求主模型直接看像素，不调用 Read 或委派子代理读图。
- **验证**: 失败会话证实原用户消息为纯字符串且 image block 为 0；修复后 Rust 多模态测试 6/6，前端回归 14/14，TypeScript 与诊断通过；用原任务 5 张真实素材实测，vision 模型确认看到 5 张并逐张描述出不同主体与构图；应用 PID 39980 已加载新构建。
