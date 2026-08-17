---
title: gitea 支持 .rst 格式化
slug: gitea-rst-format
summary: 为 Gitea 开启并配置 reStructuredText 文档渲染。
publishedAt: 2023-01-28
tags:
  - Gitea
  - reStructuredText
  - 运维
cover: null
---
[https://github.com/go-gitea/gitea/issues/374#issuecomment-423688581](https://github.com/go-gitea/gitea/issues/374#issuecomment-423688581)

1.  pip 安装 `docutils`
2.  修改`app.ini`
    
    ```ini
    [markup.restructuredtext]
    ENABLED = true
    FILE_EXTENSIONS = .rst
    RENDER_COMMAND = rst2html.py
    IS_INPUT_FILE = false
    ```
    
3.  修改模板文件。`rst2html.py --help` 中 `--template` 参数有写默认位置，或者用此参数自定义 template 位置。模板文件内容为：
    
    ```text
    %(body_pre_docinfo)s
    %(docinfo)s
    %(body)s
    ```
