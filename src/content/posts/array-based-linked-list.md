---
title: 基于数组的链表实现
slug: array-based-linked-list
summary: 探索基于数组而不是节点对象的链表实现。
publishedAt: 2022-12-09
tags:
  - Java
  - 数据结构
  - 源码
cover: null
---
# 前言

链表是一种由“节点”组成的数据结构，每个节点都储存着指向下一个节点的指针。通常来讲，指针都是存储的物理地址，因此在无法获取物理地址的语言里无法实现（比如BASIC）；不过，其实也有别的方法在这些语言里实现指针的功能——即使用数组，以对象在数组内的索引作为指针的值。

传统的链表实现是定义节点对象的结构，用一个个独立的节点构建链表，不过这种做法在Java中空间效率并不是最高的。在64位Hotspot中，每个对象都有128位的对象头，里面包含了对象类型、对象锁、GC分代信息等。一个单向链表的节点对象最小需要两个引用，即16字节，加上对象头一共32字节，对象头的占比高达50%，这对内存而言是非常大的浪费。

传统的关系型数据库是按行存储的，每条记录都存储在“行”中；后来发展出了列数据库，数据被存在“列”中。这种列式存储的思维可以帮助我们实现另一种形式的“列式”链表。

# 基本思路

以数组表达的列的形式储存节点的所有属性，我们实现的是一个单向链表，需要两个数组，分别是next数组和value数组。我们使用一个变量head表示列表头，head指向列表头，而被head指向的节点则指向它的下一个节点，以此类推。为了支持从队列尾添加数据，我们还需要一个tail变量用来缓存链表尾的索引。同时，我们还有一个缓存链表大小的size

我们这个链表如果每次增删对象都要拷贝或者复制数组的话，运行效率会变得非常低（时间复杂度O(n)），因此我们在一个数组中实现了两个平行的链表，我将其命名为values链表（简称V）和empty链表（简称E），V用来存储数据，而E则用来暂存被删除的节点以待复用。从V中删除的节点都会同步加入E中，而当插入节点的时候也会优先取用E的节点。

参考 ArrayList 的实现，为了防止频繁复制数组，我们在empty链表用尽，需要扩容的时候还会额外扩容一部分空间。由于前文定义的E链表与V链表的性质，我们可以推导出E与V的组合体储存在一片连续的空间中，我们用变量used来表示这一段内存的结尾。当我们需要新的节点时，我们直接取used所指向的节点即可。

# 实现完备性证明

## push 函数

push 函数把元素添加到链表头。

数组容量校验过程略。

push对象需要先获取一个节点，根据前面的定义，我们会优先从E链表中取节点，否则从used取节点。我们将这两种情况分开讨论。

### 当E链表为空时

### 当E链表不为空时

未完待续

# 源码

```java
import java.util.Arrays;

public class RowLinkedStack<V> {
    private int[] nextArray;
    private Object[] values;
    private int head = -1;
    private int tail = -1;
    private int empty = -1;
    private int used = 0;
    private int size = 0;

    public void append(V obj) {
        if (nextArray == null || used >= nextArray.length) {
            resize();
        }

        if (empty < 0) {
            if (tail < 0) {
                head = used;
            } else {
                nextArray[tail] = used;
            }
            nextArray[used] = -1;
            values[used] = obj;
            tail = used++;
        } else {
            int nextEmpty = nextArray[empty];
            if (tail < 0) {
                head = empty;
            } else {
                nextArray[tail] = empty;
            }
            nextArray[empty] = -1;
            values[empty] = obj;
            tail = empty;
            empty = nextEmpty;
        }

        size++;
    }

    public void push(V obj) {
        if (nextArray == null || used >= nextArray.length) {
            resize();
        }

        if (empty < 0) {
            nextArray[used] = head;
            values[used] = obj;
            head = used++;
        } else {
            int nextEmpty = nextArray[empty];
            nextArray[empty] = head;
            values[empty] = obj;
            head = empty;
            empty = nextEmpty;
        }

        if (tail < 0) {
            tail = head;
        }

        size++;
    }

    public V pop() {
        if (head < 0) {
            return null;
        }

        V value = (V) values[head];
        values[head] = null;
        int next = nextArray[head];
        nextArray[head] = empty;
        empty = head;
        head = next;

        if (head < 0) {
            tail = -1;
        }

        size--;
        gc();

        return value;
    }

    public V removeAt(int index) {
        if (index >= size) {
            throw new IndexOutOfBoundsException();
        }

        if (index == 0) {
            return pop();
        }

        int node = head;
        for (int i = 1; i < index; i++) {
            if (node == -1) {
                throw new IndexOutOfBoundsException();
            }
            node = nextArray[node];
        }

        int next = nextArray[node];
        nextArray[node] = nextArray[next];

        nextArray[next] = empty;
        empty = next;

        Object value = values[next];
        values[next] = null;

        if (next == tail) {
            tail = node;
        }

        size--;
        gc();

        return (V) value;
    }

    @Override
    public String toString() {
        return toString2();
    }

    private String toString1() {
        return "RowLinkedStack(" + size + ")";
    }

    private String toString2() {
        StringBuilder builder = new StringBuilder("[");
        int head = this.head;
        while (head >= 0) {
            if (builder.length() != 1) {
                builder.append(", ");
            }
            builder.append(values[head]);
            head = nextArray[head];
        }
        builder.append("]");
        return builder.toString();
    }

    private void resize() {
        int newSize;
        if (nextArray == null) {
            nextArray = new int[16];
            values = new Object[16];
            return;
        } else if (nextArray.length < 16) {
            newSize = 16;
        } else {
            newSize = nextArray.length * 2;
        }

        nextArray = Arrays.copyOf(nextArray, newSize);
        values = Arrays.copyOf(values, newSize);
    }

    private void gc() {
        if (nextArray.length <= 16 || size >= used / 4) {
            return;
        }

        Object[] newValues = new Object[nextArray.length / 2];
        int[] newNexts = new int[nextArray.length / 2];
        int head = this.head;
        for (int i = 0; i < size; i++) {
            newNexts[i] = i - 1;
            newValues[size - i - 1] = values[head];
            head = nextArray[head];
        }

        nextArray = newNexts;
        values = newValues;
        empty = -1;
        used = size;
        this.head = used - 1;
        tail = this.head < 0 ? -1 : 0;
    }
}
```
