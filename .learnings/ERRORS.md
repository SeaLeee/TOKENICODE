# Errors

Command failures and integration errors.

---

## [ERR-20260909-001] skillhub-download-head

**Logged**: 2026-09-09
**Priority**: low
**Status**: resolved
**Area**: backend

### Summary
SkillHub's download endpoint rejects HEAD requests with HTTP 405.

### Error
```
HTTP 405 Method Not Allowed
```

### Context
- The download URL returned a ZIP successfully with a GET request.
- Related Files: src-tauri/src/lib.rs

### Suggested Fix
Validate the download endpoint with GET rather than HEAD.

### Metadata
- Reproducible: yes
- Related Files: src-tauri/src/lib.rs

---

## [ERR-20260909-002] multimodal-change-validation

**Logged**: 2026-09-09
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
首次补丁因上下文锚点不精确而未应用；改为读取精确片段后拆分补丁成功。`.ai-memory` 目录尚未初始化。Rust 全量测试另有 2 个既有 Windows 路径解码用例失败，与多模态改动无关；新增多模态测试均通过。

### Suggested Fix
在高改动工作树中先读取接口的精确邻近片段；Windows 路径解码测试应另行修复。

### Metadata
- Reproducible: yes
- Related Files: src-tauri/src/lib.rs, src/stores/chatStore.ts

---

## [ERR-20260909-003] claude-stream-json-startup-stall

**Logged**: 2026-09-09
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
Claude Code 2.1.237 rejects `--input-format stream-json` without `--print`, leaving the UI at “正在启动 Agent”. On Windows, killing only the `claude.cmd` wrapper also left orphaned `claude.exe` processes competing to resume the same session.

### Suggested Fix
Always pair stream-json input with `--print`; terminate the complete Windows process tree with `taskkill /T /F`.

### Metadata
- Reproducible: yes
- Related Files: src-tauri/src/lib.rs

---

## [ERR-20260909-004] unavailable-local-mcp-delays-first-request

**Logged**: 2026-09-09
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
An unreachable HTTP MCP at `localhost:8080` delayed Claude Code's first API request by about 90 seconds, making the UI appear stuck at Agent startup.

### Suggested Fix
Probe loopback HTTP/SSE MCP endpoints before adding them to the per-session strict config. Skip unavailable endpoints for that session while preserving their saved configuration.

### Metadata
- Reproducible: yes
- Related Files: src-tauri/src/lib.rs

---

## [ERR-20260909-005] powershell-native-json-argument-quoting

**Logged**: 2026-09-09
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
PowerShell 5.1 stripped or altered inline JSON passed to native CLI flags such as `--settings` and `--mcp-config`, producing misleading invalid-JSON failures.

### Suggested Fix
Use a validated JSON file for native CLI configuration arguments, and include TOKENICODE's `MSYS_NO_PATHCONV` / `MSYS2_ARG_CONV_EXCL` environment when reproducing Windows launches.

### Metadata
- Reproducible: yes
- Related Files: src-tauri/src/lib.rs

---

## [ERR-20260909-006] windows-session-log-search

**Logged**: 2026-09-09
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
当前 PowerShell 环境没有 `rg`，且 PowerShell 5.1 `ConvertFrom-Json` 无法稳定解析大型 Claude JSONL 中的部分转义内容。

### Suggested Fix
诊断大型 Claude 会话时使用 Node.js `readline` 流式逐行解析，并只输出脱敏后的消息类型和摘要。

### Metadata
- Reproducible: yes
- Related Files: none

---

## [ERR-20260909-007] windows-test-harness-socket-missing

**Logged**: 2026-09-09
**Priority**: medium
**Status**: open
**Area**: tooling

### Summary
Windows debug app logs that the test harness is registered at `/tmp/tokenicode-test.sock`, but no socket is created at the POSIX path or its `C:\tmp` / `F:\tmp` equivalents. `scripts/tokenicode-cli.mjs` therefore cannot connect even while the desktop process and Vite server are running.

### Suggested Fix
Use a Windows-supported transport/path in `tauri-plugin-mcp`, or make the harness and CLI agree on a named-pipe endpoint on Windows.

### Metadata
- Reproducible: yes
- Related Files: src-tauri/src/lib.rs, scripts/tokenicode-cli.mjs

---

## [ERR-20260909-008] git-diff-check-stdin

**Logged**: 2026-09-09
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
Piping `git diff` into `git diff --check --stdin` is invalid because `git diff --check` does not consume a patch from stdin and interprets the piped text as revisions.

### Suggested Fix
Run `git diff --check -- <paths>` directly.

### Metadata
- Reproducible: yes

---