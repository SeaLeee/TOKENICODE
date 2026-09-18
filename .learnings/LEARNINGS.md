# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260909-001] correction

**Logged**: 2026-09-09
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
图片路径转换不能只识别“整行等于路径”；真实用户会把多个绝对路径嵌在编号说明段落中。

### Details
失败会话的用户消息是纯字符串且 image block 数为 0。路径位于“参考图 F:\\...”等正文内部，旧提取器未命中，模型随后调用 Read 和视觉子代理，均只收到路径而没有像素。

### Suggested Action
扫描正文中真实存在且格式受支持的绝对图片路径，移除路径但保留周围语义，并在图片块提示中明确禁止再次调用 Read 或委派读图。

### Metadata
- Source: user_feedback
- Related Files: src-tauri/src/lib.rs
- Tags: multimodal, image-path, claude-cli

---