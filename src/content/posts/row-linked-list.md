---
title: 行式链表 RowLinkedList 源码
slug: row-linked-list
summary: 基于数组实现的 RowLinkedList 双向链表源码。
publishedAt: 2022-12-10
tags:
  - Java
  - 数据结构
  - 源码
cover: null
---
```java
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.util.*;

/**
 * a linked list which based on array but not node object
 *
 * @param <E> contains element
 */
public class RowLinkedList<E>
    extends AbstractList<E>
    implements Deque<E>, Cloneable, java.io.Serializable {

    @Target(ElementType.METHOD)
    @Retention(RetentionPolicy.SOURCE)
    private @interface UnsafeMethod {
        String reason() default "";
    }

    @Target(ElementType.METHOD)
    @Retention(RetentionPolicy.SOURCE)
    private @interface SafeMethod {
    }

    private interface NodeSetter {
        void set(@NotNull RowLinkedList<?> list, int node);
    }

    private static final int NULL_NODE = -1;
    private static final NodeSetter headSetter = (list, node) -> list.head = node;
    private static final NodeSetter tailSetter = (list, node) -> list.tail = node;

    private int[] nextArray;
    private int[] prevArray;
    private Object[] elements;
    private int head = NULL_NODE;
    private int tail = NULL_NODE;
    private int empty = NULL_NODE;
    private int used = 0;
    private int size = 0;

    @Override
    public void addFirst(@Nullable E element) {
        resize();

        int node = insertNode(element, head, nextArray, prevArray);
        if (head == NULL_NODE) {
            tail = node;
        }
        head = node;
    }

    @Override
    public void addLast(@Nullable E element) {
        resize();

        int node = insertNode(element, tail, prevArray, nextArray);
        if (tail == NULL_NODE) {
            head = node;
        }
        tail = node;
    }

    @Override
    public boolean offerFirst(E e) {
        addFirst(e);
        return true;
    }

    @Override
    public boolean offerLast(E e) {
        addLast(e);
        return true;
    }

    @Override
    public E removeFirst() {
        int node = removeFirstNode();
        if (node == NULL_NODE) {
            throw new NoSuchElementException();
        } else {
            return popElement(node);
        }
    }

    @UnsafeMethod
    private int insertNode(@Nullable E element, int tail, @NotNull int[] prevArray, @NotNull int[] nextArray) {
        int node = alloc();
        elements[node] = element;
        nextArray[node] = NULL_NODE;
        if (tail != NULL_NODE) {
            nextArray[tail] = node;
        }
        prevArray[node] = tail;
        nextArray[node] = NULL_NODE;
        size++;
        return node;
    }

    @Override
    public E removeLast() {
        int node = removeLastNode();
        if (node == NULL_NODE) {
            throw new NoSuchElementException();
        } else {
            return popElement(node);
        }
    }

    @Override
    public E pollFirst() {
        int node = removeFirstNode();
        if (node == NULL_NODE) {
            return null;
        } else {
            return popElement(node);
        }
    }

    @Override
    public E pollLast() {
        int node = removeLastNode();
        if (node == NULL_NODE) {
            return null;
        } else {
            return popElement(node);
        }
    }

    @Override
    public E getFirst() {
        if (head == NULL_NODE) {
            throw new NoSuchElementException();
        } else {
            //noinspection unchecked
            return (E) elements[head];
        }
    }

    @Override
    public E getLast() {
        if (tail == NULL_NODE) {
            throw new NoSuchElementException();
        } else {
            //noinspection unchecked
            return (E) elements[tail];
        }
    }

    @Override
    public E peekFirst() {
        if (head == NULL_NODE) {
            return null;
        } else {
            //noinspection unchecked
            return (E) elements[head];
        }
    }

    @Override
    public E peekLast() {
        if (tail == NULL_NODE) {
            return null;
        } else {
            //noinspection unchecked
            return (E) elements[tail];
        }
    }

    @Override
    public boolean removeFirstOccurrence(Object o) {
        for (int node = head; node != NULL_NODE; node = nextArray[node]) {
            if (Objects.equals(elements[node], o)) {
                removeNode(node);
                elements[node] = null;
                return true;
            }
        }
        return false;
    }

    @Override
    public boolean removeLastOccurrence(Object o) {
        for (int node = tail; node != NULL_NODE; node = prevArray[node]) {
            if (Objects.equals(elements[node], o)) {
                removeNode(node);
                elements[node] = null;
                return true;
            }
        }
        return false;
    }

    @Override
    public int size() {
        return size;
    }

    @NotNull
    @Override
    public Iterator<E> descendingIterator() {
        return new DesItr<>(listIterator(size));
    }

    @Override
    public Iterator<E> iterator() {
        return listIterator();
    }

    @Override
    public ListIterator<E> listIterator(int index) {
        return new ListItr(index);
    }

    @Override
    public boolean add(E e) {
        return offerLast(e);
    }

    @Override
    public void add(int index, E element) {
        if (index < 0 || index >= size) {
            throw new IndexOutOfBoundsException();
        }

        int node = node(index);
        linkBefore(node, element);
    }

    @Override
    public E set(int index, E element) {
        if (index < 0 || index >= size) {
            throw new IndexOutOfBoundsException();
        }

        int node = node(index);
        Object old = elements[node];
        elements[node] = element;
        //noinspection unchecked
        return (E) old;
    }

    @Override
    public E get(int index) {
        if (index < 0 || index >= size) {
            throw new IndexOutOfBoundsException();
        }

        //noinspection unchecked
        return (E) elements[node(index)];
    }

    @Override
    public E remove(int index) {
        if (index < 0 || index >= size) {
            throw new IndexOutOfBoundsException();
        }

        int node = node(index);
        removeNode(node);
        return popElement(node);
    }

    @Override
    public boolean offer(E e) {
        return offerLast(e);
    }

    @Override
    public E remove() {
        return removeFirst();
    }

    @Override
    public E poll() {
        return pollFirst();
    }

    @Override
    public E element() {
        return getFirst();
    }

    @Override
    public E peek() {
        return peekFirst();
    }

    @Override
    public void push(E e) {
        addFirst(e);
    }

    @Override
    public E pop() {
        return removeFirst();
    }

    @Override
    public boolean remove(Object o) {
        return removeFirstOccurrence(o);
    }

    @Override
    public void clear() {
        for (int i = 0; i < used; i++) {
            elements[i] = null;
        }

        head = tail = empty = NULL_NODE;
        size = used = 0;
    }

    @Override
    protected Object clone() throws CloneNotSupportedException {
        int size = 16;
        while (size < this.size) {
            size <<= 1;
        }

        //noinspection unchecked
        RowLinkedList<E> clone = (RowLinkedList<E>) super.clone();

        clone.elements = new Object[size];
        clone.prevArray = new int[size];
        clone.nextArray = new int[size];

        int node = head;
        for (int i = 0; i < this.size; i++) {
            clone.prevArray[i] = i - 1;
            clone.nextArray[i] = i + 1;
            clone.elements[i] = elements[node];
            node = nextArray[node];
        }

        clone.used = clone.size = this.size;
        if (this.size == 0) {
            clone.head = clone.tail = NULL_NODE;
        } else {
            clone.head = 0;
            clone.tail = this.size - 1;
            clone.nextArray[size - 1] = -1;
        }

        return clone;
    }

    @UnsafeMethod(reason = "node may be out of index")
    private void linkBefore(int node, E element) {
        // TODO test
        if (node == NULL_NODE) {
            addLast(element);
            return;
        }

        int newNode = alloc(element, prevArray[node], nextArray[node]);
        if (prevArray[node] == NULL_NODE) {
            head = newNode;
        } else {
            nextArray[prevArray[node]] = newNode;
        }

        prevArray[node] = newNode;
    }

    /**
     * @param node element node index
     * @return removed element
     */
    @UnsafeMethod(reason = "uncheck node")
    private E popElement(int node) {
        Object element = elements[node];
        elements[node] = null;
        //noinspection unchecked
        return (E) element;
    }

    /**
     * @return removed last node index, may be NULL_NODE
     */
    @SafeMethod
    private int removeFirstNode() {
        return removeLastNode(head, nextArray, prevArray, tailSetter, headSetter);
    }

    @SafeMethod
    private int removeLastNode() {
        return removeLastNode(tail, prevArray, nextArray, headSetter, tailSetter);
    }

    @UnsafeMethod(reason = "array and setter must be careful")
    private int removeLastNode(
        int node,
        @NotNull int[] prevArray, @NotNull int[] nextArray,
        @NotNull NodeSetter headSetter, @NotNull NodeSetter tailSetter
    ) {
        // TODO test
        if (node == NULL_NODE) {
            return -1;
        }

        tailSetter.set(this, prevArray[node]);
        if (prevArray[node] == NULL_NODE) {
            headSetter.set(this, NULL_NODE);
        } else {
            nextArray[prevArray[node]] = NULL_NODE;
        }

        pushEmpty(node);

        size--;
        gc();

        return node;
    }

    @UnsafeMethod(reason = "not removed element")
    private void removeNode(int node) {
        // TODO test
        if (node == NULL_NODE) {
            return;
        }

        // node.prev == null
        if (prevArray[node] == NULL_NODE) {
            // head = null
            head = NULL_NODE;
        } else {
            // node.prev.next = node.next
            nextArray[prevArray[node]] = nextArray[node];
        }

        // node.next == null
        if (nextArray[node] == NULL_NODE) {
            // tail = null
            tail = NULL_NODE;
        } else {
            // node.next.prev = node.prev
            prevArray[nextArray[node]] = prevArray[node];
        }

        pushEmpty(node);

        size--;
        gc();
    }

    /**
     * push freed node to empty stack
     *
     * @param node freed node index
     */
    @UnsafeMethod(reason = "node may be NULL_NODE")
    private void pushEmpty(int node) {
        nextArray[node] = empty;
        empty = node;
    }

    /**
     * unchecked method of [this.empty]
     * get a free node from empty stack
     *
     * @return node index pop from empty stack
     */
    @UnsafeMethod(reason = "this.empty may be NULL_NODE")
    private int popEmpty() {
        int empty = this.empty;
        this.empty = nextArray[empty];
        return empty;
    }

    /**
     * checked method
     * alloc free node from unused space or empty stack
     *
     * @return allocated node index
     */
    @SafeMethod
    private int alloc() {
        if (empty == NULL_NODE) {
            resize();

            return used++;
        } else {
            return popEmpty();
        }
    }

    @SafeMethod
    private int alloc(E element, int prev, int next) {
        int node = alloc();
        elements[node] = element;
        prevArray[node] = prev;
        nextArray[node] = next;
        return node;
    }

    @UnsafeMethod(reason = "unlimited increase memory usage")
    private void resize() {
        if (nextArray != null && used < nextArray.length) {
            return;
        }

        int newSize;
        if (nextArray == null) {
            prevArray = new int[16];
            nextArray = new int[16];
            elements = new Object[16];
            return;
        } else if (nextArray.length < 16) {
            newSize = 16;
        } else {
            newSize = nextArray.length * 2;
        }

        prevArray = Arrays.copyOf(prevArray, newSize);
        nextArray = Arrays.copyOf(nextArray, newSize);
        elements = Arrays.copyOf(elements, newSize);
    }

    @SafeMethod
    private void gc() {
        if (size == 0) {
            empty = NULL_NODE;
            used = 0;
            return;
        }

        if (nextArray.length <= 16 || size >= used / 8) {
            return;
        }

        Object[] newElements = new Object[nextArray.length / 4];
        int[] newPrev = new int[nextArray.length / 4];
        int[] newNext = new int[nextArray.length / 4];
        int node = this.head;
        for (int i = 0; node >= 0; i++) {
            newPrev[i] = i - 1;
            newNext[i] = i + 1;
            newElements[size - i - 1] = elements[node];
            node = nextArray[node];
        }
        newNext[size - 1] = -1;

        prevArray = newPrev;
        nextArray = newNext;
        elements = newElements;
        empty = -1;
        used = size;
        this.tail = used - 1;
        head = 0;
    }

    private int node(int index) {
        if (index < (size >> 1)) {
            int node = head;
            for (int i = 0; i < index; i++)
                node = nextArray[node];
            return node;
        } else {
            int node = tail;
            for (int i = size - 1; i > index; i--)
                node = prevArray[node];
            return node;
        }
    }

    private class ListItr implements ListIterator<E> {
        private int next;
        private int nextIndex;
        private int lastReturned = NULL_NODE;

        private ListItr(int index) {
            if (head == NULL_NODE || index == size) {
                next = NULL_NODE;
                return;
            }

            nextIndex = index;
            next = node(index);
        }

        @Override
        public boolean hasNext() {
            return next != NULL_NODE;
        }

        @Override
        public E next() {
            if (next == NULL_NODE) {
                throw new NoSuchElementException();
            }

            lastReturned = next;
            next = nextArray[next];
            //noinspection unchecked
            return (E) elements[lastReturned];
        }

        @Override
        public boolean hasPrevious() {
            return nextIndex > 0;
        }

        @Override
        public E previous() {
            if (!hasPrevious()) {
                throw new NoSuchElementException();
            }

            lastReturned = next = next == NULL_NODE ? tail : prevArray[next];
            nextIndex--;
            //noinspection unchecked
            return (E) elements[lastReturned];
        }

        @Override
        public int nextIndex() {
            return nextIndex;
        }

        @Override
        public int previousIndex() {
            return nextIndex - 1;
        }

        @Override
        public void remove() {
            if (lastReturned == NULL_NODE)
                throw new IllegalStateException();

            if (next == lastReturned) {
                next = nextArray[lastReturned];
            } else {
                nextIndex--;
            }
            removeNode(lastReturned);
            popElement(lastReturned);
            lastReturned = NULL_NODE;
        }

        @Override
        public void set(E e) {
            if (lastReturned == NULL_NODE) {
                throw new IllegalStateException();
            }
            elements[lastReturned] = e;
        }

        @Override
        public void add(E e) {
            lastReturned = NULL_NODE;
            if (next == NULL_NODE) {
                addLast(e);
            } else {
                linkBefore(next, e);
            }
            nextIndex++;
        }
    }

    private static class DesItr<E> implements Iterator<E> {
        private final ListIterator<E> itr;

        private DesItr(ListIterator<E> itr) {
            this.itr = itr;
        }

        @Override
        public boolean hasNext() {
            return itr.hasPrevious();
        }

        @Override
        public E next() {
            return itr.previous();
        }
    }
}
```
