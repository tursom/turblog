---
title: 对go atomic泛型化的尝试
slug: go-atomic-generics
summary: 尝试将 Go atomic 操作泛型化。
publishedAt: 2022-12-03
tags:
  - Go
  - 原子操作
  - 泛型
cover: null
---
本文源码可查看 [https://github.com/tursom/GoCollections/tree/master/lang/atomic](https://github.com/tursom/GoCollections/tree/master/lang/atomic)

GO 在1.18终于添加了泛型。有了泛型，我们对一些泛用接口就有了更好的约束手段，合理使用泛型可以更好的复用代码。而本文则是在泛型技术的基础上对GO的原子操作简化的尝试。

我在atmoic包里定义了 `Atmoic[T any]` 接口，这个接口定义了针对泛型 T 的原子化实现，包括 `Load`、`Store`、`Swap`以及最重要的`CompareAndSwap`。我还定义了 `Atomizer[T any]`接口以提供操作不同类型的方法工厂，这个接口提供四个无参函数，分别返回操作其指定类型的四个原子化方法。默认提供的实现是`atomizerImpl[T]`，提供 (u)int32/64 以及引用的共五种 Atomizer。考虑到开发中几乎不会需要自定义 Atomizer，类型 atomizerImpl 并没有被导出。

```go
type (
    Atomic[T any] interface {
        Swap(new T) (old T)
        CompareAndSwap(old, new T) (swapped bool)
        Load() (val T)
        Store(val T)
    }

    Atomizer[T any] interface {
        Swap() func(addr *T, new T) (old T)
        CompareAndSwap() func(addr *T, old, new T) (swapped bool)
        Load() func(addr *T) (val T)
        Store() func(addr *T, val T)
    }

    atomizerImpl[T any] struct {
        swap           func(addr *T, new T) (old T)
        compareAndSwap func(addr *T, old, new T) (swapped bool)
        load           func(addr *T) (val T)
        store          func(addr *T, val T)
    }
)
```

全部五种 Atomizer 实现都提供了对应的获取方法，值得一提的是由于`unsafe.Pointer`与引用有完全相同的内存结构，所以你获取到的针对特定类型引用的 Atomizer 其实就是实现 unsafe.Pointer 原子化的`pointerAtomizer`。

```go
var (
    int32Atomizer *atomizerImpl[int32]
    int64Atomizer *atomizerImpl[int64]
    uint32Atomizer *atomizerImpl[uint32]
    uint64Atomizer *atomizerImpl[uint64]
    pointerAtomizer *atomizerImpl[unsafe.Pointer]
)

func GetAtomizer[T any]() Atomizer[*T] {
    // atomizerImpl[*T] 与 atomizerImpl[unsafe.Pointer] 有完全一致的内存结构
    // 因此可以通过 unsafe 强制转换
    return (*atomizerImpl[*T])(unsafe.Pointer(pointerAtomizer))
}
```

对 GO 泛型的探索同样体现在函数`CompareAndSwapBit`上，其泛型类型被限定在了 int32/64 与 uint32/64 中。这个函数还要求用户提供对应类型的 cas 实现函数。在没有泛型的时代，这个函数至少需要为32位和64位类型分别提供两个函数。

```go
func CompareAndSwapBit[T int32 | int64 | uint32 | uint64](cas func(p *T, old, new T) bool, p *T, bit int, old, new bool) bool {
    location := T(1) << bit
    oldValue := *p
    if old {
        oldValue = oldValue | location
    } else {
        oldValue = oldValue & ^location
    }
    var newValue T
    if new {
        newValue = oldValue | location
    } else {
        newValue = oldValue & ^location
    }
    return cas(p, oldValue, newValue)
}
```

我还尽可能多的为基础类型定义了对应的原子类，比如 int8 的原子化类`type Int8 int8`。这样定义类可以方便对象在不同“描述”之间的转换，不过还是有例外，在我尝试实现对指针的原子化时出了意外：GO的编译器不接受指针类型作为接收器，我们无法为其定义成员函数。因此，我只能采用更传统的写法，定义一个新结构体`Reference[T any]`：

```go
// Reference atomizer type T reference
Reference[T any] struct {
    lang.BaseObject
    p *T
}
```

`lang.BaseObject`是一个0长度的结构体，实现了一些通用的`lang.Object`的约束，不过这不是本文的重点。重点在于`Reference[T]`在内存层面上讲其实就是`*T`，只不过在语法上套了一层皮而已。Reference 所有的成员函数都使用引用接收器，在内存上讲本质就是`**T`，因此我们还可以将`**T`“解释” 为`*Reference[T]`，这个过程是纯粹的 unsafe 类型转换，不需要任何堆内存开销，这就是函数`ReferenceOf`的实现原理：

```go
// ReferenceOf cast **T to *Reference[T]
func ReferenceOf[T any](reference **T) *Reference[T] {
    return unsafe2.ForceCast[Reference[T]](Pointer(reference))
}
```
