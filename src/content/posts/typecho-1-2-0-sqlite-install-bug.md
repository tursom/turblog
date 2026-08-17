---
title: Typecho 1.2.0 sqlite 安装 bug 及修复方法
slug: typecho-1-2-0-sqlite-install-bug
summary: 记录 Typecho 1.2.0 使用 SQLite 安装时的路径校验问题及修复方法。
publishedAt: 2022-06-29
tags:
  - Typecho
  - PHP
  - SQLite
cover: null
---
我在2022年6月28日将自己的博客服务从 zblog 切换到了 Typecho，在安装期间遇到了一点小问题。

考虑到方便迁移的因素，我选择使用 sqlite 作为博客的数据库。但是我在尝试安装 Typecho 1.2.0 的时候服务器不断报错，显示“确认您的配置”。

<picture>
  <source type="image/webp" srcset="/images/legacy/post-typecho-1-2-0-sqlite-install-bug-1-480.webp 480w, /images/legacy/post-typecho-1-2-0-sqlite-install-bug-1-800.webp 800w" sizes="(max-width: 780px) 100vw, 720px" />
  <img src="/images/legacy/post-typecho-1-2-0-sqlite-install-bug-1.png" alt="确认您的配置" loading="lazy" decoding="async" width="1004" height="559" />
</picture>

在 Google 上搜索，给出的解决方案都是更改PHP的配置 output\_buffering = on，比如[这里](http://www.luxiangyong.com/index.php/archives/11/)和[这里](https://zhuanlan.zhihu.com/p/45901367)。很明显，这是一个被转载烂了的文章。

我尝试使用这个方法，但是问题没有解决。我又尝试给 PHP 安装缺少的插件，问题也没有解决。最终，我决定去 GitHub [Typecho repo](https://github.com/typecho/typecho) 的 [issues](https://github.com/typecho/typecho/issues) 里看一下有没有类似的问题。

我发现这个问题在 1.2.0 发布的当天就被发现了，issues地址为[https://github.com/typecho/typecho/pull/1357](https://github.com/typecho/typecho/pull/1357)。导致问题的原因是 Typecho 安装路径中有字符点“.”，而负责校验 sqlite 路径的正则不允许路径中有点存在。宝塔面板创建的站点路径默认是其站点基础路径（在linux上默认是 /www/wwwroot）+站点域名，比如我的 Typecho 安装路径就为 /www/wwwroot/blog.tursom.cn，这个路径是无法通过校验的。

这个 bug 已经在 [PR 1357](https://github.com/typecho/typecho/pull/1357) 被修复，如果不出意外将会在下个发布版改正。而在下个 Typecho 发布版发行之前，我们有以下几种修复方式：

### 1\. 手动合并[PR 1357](https://github.com/typecho/typecho/pull/1357)的更改

找到你的 Typecho 安装路径，修改 install.php 的第 1025 行为：

```php
return !!preg_match("/^(\/[._a-z0-9-]+)*[a-z0-9]+\.[a-z0-9]{2,}$/i", $path);
```

### 2\. 跳过 sqlite 路径校验

或者，如果你对你的数据有信心，你可以跳过这个校验。同样是 install.php 的第 1025 行：

```php
return true;
```

这样，你就可以正常的安装 Typecho 到 sqlite 了。
