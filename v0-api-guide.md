# v0 API 调通指南

前置：Base URL `https://api.v0.dev/v1`，请求头带 `Authorization: Bearer <你的Key>`。

## 1. 怎么发起会话（可指定模型）

```bash
curl -s https://api.v0.dev/v1/chats -X POST \
  -H "Authorization: Bearer $V0_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "把这段代码改成暗色主题"}'
```

`message` 必填。`$V0_API_KEY` 即你的 Key，如 `v1:team_xxx:vcp_xxx`。

想自己选模型，加一个 `modelConfiguration` 即可：

```bash
-d '{"message": "写个登录页", "modelConfiguration": {"modelId": "v0-max", "thinking": true}}'
```

可选模型 `modelId`（默认 `v0-pro`，`v0-auto` 已废弃）。`v0-*` 只是 v0 的封装档位：

| modelId | 大致定位 |
|---|---|
| `v0-mini` | 轻量快，便宜 |
| `v0-pro` | 默认标准 |
| `v0-max` | 最强但慢/贵 |
| `v0-max-fast` | 强且快 |

**也可以直接指定外部模型**：`modelConfiguration.modelId` 实际走的是 Vercel AI Gateway，接受 **`creator/model` 格式**（OpenAPI 里的 `v0-*` 枚举不是硬限制）。以下均已实测跑通：

```bash
-d '{"message":"hi","modelConfiguration":{"modelId":"anthropic/claude-opus-5"}}'        # Claude Opus 5
-d '{"message":"hi","modelConfiguration":{"modelId":"anthropic/claude-sonnet-4-5"}}'   # Claude
-d '{"message":"hi","modelConfiguration":{"modelId":"anthropic/claude-fable-5"}}'       # Claude Fable 5
-d '{"message":"hi","modelConfiguration":{"modelId":"openai/gpt-4o-mini"}}'            # OpenAI
```

> 写错格式会 422：`Gateway model IDs must use creator/model format`。想用哪个 Claude 模型，照 `anthropic/claude-<模型名>` 填即可（网页版选模型处能看到的 ID 都能填；`claude-opus-5` / `claude-opus-4-8` 已验证可用）。

其它可配：`thinking`(深度思考)、`thinkingEffort`、`imageGenerations`(出图)、`fast`。

注意：**模型在建会话那一刻定死**，建好后改不了（PATCH 只允许改 name/privacy/metadata），要换模型就新建会话。外部模型费用按实际用量计。

## 2. 怎么看回复

返回 JSON 里 `id` 是会话ID，AI 回复在 `messages` 里 `role` 为 `assistant` 的那条 `content`：

```json
{
  "id": "daUMonSF0OQ",
  "messages": [
    { "role": "user",      "content": "把这段代码改成暗色主题" },
    { "role": "assistant", "content": "以下是改好的代码..." }
  ]
}
```

已发起的会话可用下面命令随时拉消息：

```bash
curl -s https://api.v0.dev/v1/chats/daUMonSF0OQ/messages \
  -H "Authorization: Bearer $V0_API_KEY"
```
