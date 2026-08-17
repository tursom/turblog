---
title: ts-socket 是如何用同步语法实现异步读写的
slug: ts-socket-sync-async
summary: 分析 ts-socket 如何用同步语法实现异步读写。
publishedAt: 2022-12-04
tags:
  - Go
  - 网络
  - 异步
cover: null
---
ts-socket 是我在大三时期做的一个研究向的产品，它的主要功能是利用Kotlin的协程技术与Java的NIO技术，为用户提供写法类似传统 Socket 的同步语法的异步读写。

从核心流程上讲，首先创建对应的ServerChannel，注册到 NioThread 上进行监听。等到有新连接进入的时候，由 ts-socket 接收连接，启动协程，并调用操作者提供的回调函数。

读写操作则是注册 NioThread 对应的读写事件，然后挂起操作者协程直到事件触发。由 ts-socket 进行读写操作并将操作结果返回给用户。

在这整个过程中，用户的语法与传统的 BIO 高度相似，以下是使用 ts-socket 实现的 echo 服务器的例子：

```kotlin
val handler: suspend BufferedAsyncSocket.() -> Unit = {
    while (open) {
      val read = read(timeout = 60 * 1000)
      write(read)
    }
}

fun main() {
  val server = BufferedNioServer(port = 12345, handler = handler)
  server.run()
}
```

# NioThread

接口 `NioThread` 所在的包`cn.tursom.niothread`包含了在独立线程上运行的，与业务逻辑无关的基础代码与接口。这个包的设计由需求驱动，因较复杂的需求而变得比较复杂。

NioThread 的逻辑架构分成三层，每层代表了不同的抽象需求。按照调用关系为：`NioThread`\->`workLoop: (thread: NioThread, key: SelectionKey) -> Unit`\->`NioProtocol`。

NioThread 代表执行 NIO 循环的线程，是最底层的部门。其负责调用`selector.select`，并将 select 出的每个 `SelectionKey`交给 workLoop 处理。NioThread 由实现原理可分为通过线程池实现的`ThreadPoolNioThread`与普通线程+while循环实现的`WorkerLoopNioThread`。

workLoop 是 NioThread 在每个循环时都会调用的回调函数，负责解析处理每个被 select 出的 SelectionKey。主要实现有`BossLoopHandler`、`WorkerLoopHandler`与`MultithreadingBossLoopHandler`。

NioProtocol 由 workLoop 调用，由用户提供，表示对应事件发生时的回调。
