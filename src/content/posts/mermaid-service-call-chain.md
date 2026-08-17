---
title: 用 Mermaid 记录服务调用链
slug: mermaid-service-call-chain
summary: 让图表和代码一起版本化，并在架构变化时保持文档可验证。
publishedAt: 2026-08-03
tags:
  - Mermaid
  - 架构
  - 文档
cover: null
---

架构图如果只存在于某个设计工具里，很快就会和代码分离。把 Mermaid 图表放进 Markdown，可以让调用链和文章一起参与评审与版本管理。

```mermaid
sequenceDiagram
    participant Browser
    participant Gateway
    participant Service
    Browser->>Gateway: GET /posts/:slug
    Gateway->>Service: render post
    Service-->>Gateway: HTML
    Gateway-->>Browser: response
```

图表不应该代替文字说明。先用文字定义边界，再用图表压缩重复信息，读者才能在异常路径中继续定位问题。
