---
title: 关于 Kotlin 可见性修饰的一些研究
slug: kotlin-visibility
summary: 研究 Kotlin 可见性修饰符的实现和使用边界。
publishedAt: 2022-12-04
tags:
  - Kotlin
  - 语言特性
cover: null
---
bennyhuo 在[新一集视频](https://www.bilibili.com/video/av563371638?p=1)中谈到了 Kotlin 与 Java 的可见性修饰问题，这个问题不仅影响程序设计，有些细节也会影响反射最终落地的实现。我曾经参与过一个 Minecraft 模组 LightLand 的开发工作，其中用到了一个使用 [ASM 技术](https://asm.ow2.io/)实现高性能反射的库 [reflectasm](https://github.com/EsotericSoftware/reflectasm)。

这个库会用 ASM 技术在运行现场制造出一个与被反射类同包（java包除外）的类，并提供相应接口以反射形式访问被反射对象。该实现导致的限制是其对可见性敏感，无法访问被反射类的私有成员，这个特性对我印象深刻，因此我在设计反射与可见性的问题上总会想到这一点，同样的，我也可以用这个特性对类成员的可见性进行初步窥探。

我一开始设计了一个涵盖 Kotlin 所有四个可见性修饰符（private、protected、internal 和 public）的类 FieldTestClass 并尝试用 reflectasm 访问他的成员变量：

```kotlin
internal class FieldTestClass {
    val i1: Int = 0
    protected val i2: Int = 0
    private val i3: Int = 0
    internal val i4: Int = 0
}

// Class.methodAccessList 是我写的一个针对 reflectasm 的扩展函数
// 详见 https://github.com/tursom/TursomServer/tree/master/ts-core/ts-reflectasm
FieldTestClass::class.java.fieldAccessList.forEach {
    println(it.fieldNames.asList())
}
```

不出意外的出意外了，我忘记了 Kotlin 在 JVM 平台的所有成员变量都是 private 的，真实的可见性是 getter 和 setter 实现的。将对应的方法改成对成员方法的获取，得到了以下输出：

```text
[getI4$ts_reflectasm, getI1, getI2]
```

-   i1 是 public 的，我们可以轻松获取到他的 getter，很正常
-   i2 是 protected 的，同包可见
-   i3 是 private 的，同包也不可见（查看字节码甚至可以看到没生成 getter）
-   i4 比较有趣，他是原本 getter 的名字后面加了当前 module 的名字（因为这段测试我是在 ts-reflectasm 中运行的），目前原理未知

以下是 FieldTestClass 字节码的反编译：

```java
@Metadata(
    mv = {1, 8, 0},
    k = 1,
    d1 = {"\u0000\u0014\n\u0002\u0018\u0002\n\u0002\u0010\u0000\n\u0002\b\u0002\n\u0002\u0010\b\n\u0002\b\b\b\u0000\u0018\u00002\u00020\u0001B\u0005¢\u0006\u0002\u0010\u0002R\u0014\u0010\u0003\u001a\u00020\u0004X\u0086D¢\u0006\b\n\u0000\u001a\u0004\b\u0005\u0010\u0006R\u0014\u0010\u0007\u001a\u00020\u0004X\u0084D¢\u0006\b\n\u0000\u001a\u0004\b\b\u0010\u0006R\u000e\u0010\t\u001a\u00020\u0004X\u0082D¢\u0006\u0002\n\u0000R\u0014\u0010\n\u001a\u00020\u0004X\u0080D¢\u0006\b\n\u0000\u001a\u0004\b\u000b\u0010\u0006¨\u0006\f"},
    d2 = {"Lcn/tursom/reflect/asm/ReflectAsmFieldTest$FieldTestClass;", "", "()V", "i1", "", "getI1", "()I", "i2", "getI2", "i3", "i4", "getI4$ts_reflectasm", "ts-reflectasm"}
)
public static final class FieldTestClass {
    private final int i1;
    private final int i2;
    private final int i3;
    private final int i4;

    public final int getI1() {
        return this.i1;
    }

    protected final int getI2() {
        return this.i2;
    }

    public final int getI4$ts_reflectasm() {
        return this.i4;
    }
}
```

### 关于 ReflectASM 的一些细节

-   查看 ReflectASM 的源码，在 MethodAccess.java 的 [109-111 行](https://github.com/EsotericSoftware/reflectasm/blob/cad4d755114e80169727fd030c85d55db3997bd8/src/com/esotericsoftware/reflectasm/MethodAccess.java#L109-L111)中，我们可以注意到如果被反射对象所在的包是以“java.”开头的，则会加上前缀“reflectasm.”以逃避 JVM 对 java 包的类加载限制。

### kotlin internal 属性在 java 中的访问

可以正常访问，以下 java 代码可以正常编译运行：

```java
package cn.tursom.reflect.asm;

public class JavaTest {
    @Test
    public void test() {
        ReflectAsmFieldTest.FieldTestClass a = new ReflectAsmFieldTest.FieldTestClass();
        System.out.println(a.getI4$ts_reflectasm());
    }
}
```
