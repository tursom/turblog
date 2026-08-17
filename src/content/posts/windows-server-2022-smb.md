---
title: Windows Server 2022 SMB 客户端无法连接问题修复
slug: windows-server-2022-smb
summary: 修复 Windows Server 2022 SMB 客户端无法连接的问题。
publishedAt: 2024-01-06
tags:
  - Windows
  - SMB
  - 系统
cover: null
---
添加 DWORD 注册表项，值为 1

```text
\HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters\AllowInsecureGuestAuth
```
