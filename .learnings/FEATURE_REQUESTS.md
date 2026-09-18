# Feature Requests

---

## [FR-20260909-001] Claude 会话图片多模态输入

**Logged**: 2026-09-09
**Status**: implemented
**Area**: chat

图片附件不能只作为文件路径文本发送；首条消息、会话追问和排队消息都应编码为 Claude stream-json 的 base64 image content block，同时保留路径文本供文件工具使用。

**Related Files**: src/components/chat/InputBar.tsx, src/hooks/useStreamProcessor.ts, src-tauri/src/lib.rs

---