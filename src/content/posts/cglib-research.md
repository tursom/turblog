---
title: 关于 cglib 实现的研究
slug: cglib-research
summary: 记录对 CGLIB 实现机制和代理过程的研究。
publishedAt: 2022-12-05
tags:
  - Java
  - CGLIB
  - 字节码
cover: null
---
cglib 是 Spring 框架默认使用的动态代理库，其主要工作原理是使用 ASM 技术在运行现场制造出被代理对象的子类，并以子类的对象替换被代理对象。其与 Java 的动态的主要不同是其不受代理接口的限制，但是无法代理 final 类。

# 研究方法与工具

cglib 的代理类是由`net.sf.cglib.proxy.Enhancer`创建的，而 Enhancer 提供`public generateClass(ClassVisitor v)`方法将生成的类写入任意`org.objectweb.asm.ClassVisitor`的实现中；而 ClassVisitor 的实现`org.objectweb.asm.ClassWriter`的方法`public byte[] toByteArray()`则支持将写入其中的类转换为字节数组，这样我们就获得了代理类的字节码了，只需要将其写入文件就可以深入研究了。

# 研究对象

为了简化研究，我定义的类比较简单，他的源码如下：

```kotlin
class Example {
  open class TestClass protected constructor() {
    open var a: Int = 0
  }
}
```

获取字节码的源码为：

```kotlin
@Test
fun getClass() {
    val writer = ClassWriter(0)
    val enhancer = Proxy.newEnhancer(TestClass::class.java)
    val clazz = enhancer.createClass()
    CglibUtil.setStaticCallbacks(clazz, arrayOf(ProxyInterceptor()))
    enhancer.generateClass(writer)
    File("TestClass.class").writeBytes(writer.toByteArray())
}
```

未完待续
