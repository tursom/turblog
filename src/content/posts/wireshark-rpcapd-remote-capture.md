---
title: 使用 wireshark + rpcapd 对 linux 服务器远程抓包
slug: wireshark-rpcapd-remote-capture
summary: 在 Linux 服务器上安装并使用 rpcapd，将远程抓包结果交给 Wireshark 分析。
publishedAt: 2023-07-17
tags:
  - Wireshark
  - Linux
  - 网络
cover: null
---
在调试数据库驱动时，我们偶尔需要对数据的时序进行分析，这就需要使用 wireshark 进行抓包。同时，我们还要防止本地开发环境的复杂性影响测试结果，我们需要在更简单的服务器上运行测试。为了实现这些测试，我们就需要找到对服务端抓包的方法。

目前最主流的方案是使用 rpcapd 将服务端的抓包结果传输到本地，大部分文章对如何使用 rpcapd 抓包有较为详细的描述，本篇则不再重复，而是将重点放在其过时或错误的部分上——即 rpcapd 的安装。

在 github 上有 [rpcapd 项目](https://github.com/rpcapd-linux/rpcapd-linux)。根据其描述，libpcap 自 v1.9.0 开始自带 rpcapd，但是需要在 configure 过程中添加 `--enable-remote`参数。经测试，在 Ubuntu 22.04 源中自带的 libpcap-dev 和 libpcap0.8 都没有 rpcapd 命令，而 Ubuntu 18.04 源的 libpcap 版本则直接是 v1.8.0。很明显，我们在 Ubuntu 上需要自己编译 rpcapd。

编译 rpcapd 的步骤为：

1.  克隆 [libpcap 项目](https://github.com/the-tcpdump-group/libpcap)
2.  执行[autogen.sh](https://github.com/the-tcpdump-group/libpcap/blob/master/autogen.sh)脚本来生成 configure 脚本
3.  运行 configure 脚本，`./configure --enable-remote`
4.  make

在 configure 过程中，可能会提示缺少依赖。根据需求安装对应依赖即可。

如果 make 的过程不出意外，那么 rpcapd 的可执行程序应该就放在 rpcapd 目录下了。我们只需要执行`sudo rpcapd/rpcapd -4 -n`就可以启动 rpcapd 服务了。默认监听的端口为 2002。
