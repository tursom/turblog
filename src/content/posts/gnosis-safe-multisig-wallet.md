---
title: Gnosis Safe 多签合约创建钱包技术解析
slug: gnosis-safe-multisig-wallet
summary: 解析 Gnosis Safe 多签合约创建钱包的技术流程。
publishedAt: 2022-07-11
tags:
  - 区块链
  - Ethereum
  - Gnosis Safe
cover: null
---
Gnosis Safe 是一个在以太坊使用相当广泛的多签钱包实现。本文旨在解析该合约在链上创建多签钱包的详细流程与技术细节。

## 钱包概览

Gnosis Safe 多签钱包的所有操作都是在链上进行的，包括创建合约与发送交易等。这笔交易就是我在 Rinkeby 以太测试网上创建钱包的一笔交易：

<picture>
  <source type="image/webp" srcset="/images/legacy/post-17-1-480.webp 480w, /images/legacy/post-17-1-800.webp 800w" sizes="(max-width: 780px) 100vw, 720px" />
  <img src="/images/legacy/post-17-1.png" alt="2022-07-05T01:53:19.png" loading="lazy" decoding="async" width="1127" height="456" />
</picture>

实际上，这笔交易是一次合约调用，由被调用的合约负责创建了这个钱包。

## 合约解析

查看收款合约的概览可得知，负责创建钱包的合约名为 [GnosisSafeProxyFactory](https://git.tursom.cn/gnosis-safe/safe-contracts/src/tag/v1.3.0/contracts/proxies/GnosisSafeProxyFactory.sol)：

<picture>
  <source type="image/webp" srcset="/images/legacy/post-17-2-480.webp 480w, /images/legacy/post-17-2-800.webp 800w, /images/legacy/post-17-2-1200.webp 1200w" sizes="(max-width: 780px) 100vw, 720px" />
  <img src="/images/legacy/post-17-2.png" alt="2022-07-05T01:57:01.png" loading="lazy" decoding="async" width="1732" height="422" />
</picture>

查看交易的输入数据，可以看到Etherscan已经解析了部分输入了：

```text
Function: createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce)

MethodID: 0x1688f0b9
[0]:  000000000000000000000000d9db270c1b5e3bd161e8c8503c55ceabee709552
[1]:  0000000000000000000000000000000000000000000000000000000000000060
[2]:  00000000000000000000000000000000000000000000000000000181b7857c3e
[3]:  0000000000000000000000000000000000000000000000000000000000000184
[4]:  b63e800d00000000000000000000000000000000000000000000000000000000
[5]:  0000010000000000000000000000000000000000000000000000000000000000
[6]:  0000000200000000000000000000000000000000000000000000000000000000
[7]:  0000000000000000000000000000000000000000000000000000000000000000
[8]:  00000160000000000000000000000000f48f2b2d2a534e402487b3ee7c18c33a
[9]:  ec0fe5e400000000000000000000000000000000000000000000000000000000
[10]: 0000000000000000000000000000000000000000000000000000000000000000
[11]: 0000000000000000000000000000000000000000000000000000000000000000
[12]: 0000000000000000000000000000000000000000000000000000000000000000
[13]: 00000002000000000000000000000000e0cab803e4635e50ee2f27d77b2543df
[14]: 5537941300000000000000000000000074a6a114a128b67b738581e366065564
[15]: 3f49fb9900000000000000000000000000000000000000000000000000000000
[16]: 0000000000000000000000000000000000000000000000000000000000000000
```

解析这些数据，可以看到函数的实参：

```text
#    Name            Type     Data
0    _singleton      address  0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552
1    initializer     bytes    0xb63e800d0000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000160000000000000000000000000f48f2b2d2a534e402487b3ee7c18c33aec0fe5e40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000e0cab803e4635e50ee2f27d77b2543df5537941300000000000000000000000074a6a114a128b67b738581e3660655643f49fb990000000000000000000000000000000000000000000000000000000000000000
2    saltNonce       uint256  1656641387582
```

我们可以看到，函数一共有\_singleton、initializer和saltNonce一共三个参数。

点进[\_singleton](https://rinkeby.etherscan.io/address/0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552#code)的值查看其详细信息，发现其实际上是合约 GnosisSafe 的一个实例。结合[合约代码注释](https://git.tursom.cn/gnosis-safe/safe-contracts/src/commit/186a21a74b327f17fc41217a927dea7064f74604/contracts/proxies/GnosisSafeProxyFactory.sol#L58)可得知，参数 \_singleton 实际上就是部署合约 GnosisSafe 的地址。

initializer 则在调用函数[deployProxyWithNonce](https://git.tursom.cn/gnosis-safe/safe-contracts/src/commit/186a21a74b327f17fc41217a927dea7064f74604/contracts/proxies/GnosisSafeProxyFactory.sol#L66)部署钱包之后，使用[call指令对部署的 proxy 合约进行初始化调用](https://git.tursom.cn/gnosis-safe/safe-contracts/src/commit/186a21a74b327f17fc41217a927dea7064f74604/contracts/proxies/GnosisSafeProxyFactory.sol#L70)。initializer 作为合约调用代码，遵守以太坊合约调用ABI。其开头便是合约ID b63e800d，到 GnosisSafe 合约中查找，可知其调用的函数为 [`function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver) returns()`](https://git.tursom.cn/gnosis-safe/safe-contracts/src/commit/186a21a74b327f17fc41217a927dea7064f74604/contracts/GnosisSafe.sol#L66-L97)。

saltNonce 根据其[合约注释](https://git.tursom.cn/gnosis-safe/safe-contracts/src/commit/186a21a74b327f17fc41217a927dea7064f74604/contracts/proxies/GnosisSafeProxyFactory.sol#L60)以及[实际操作](https://git.tursom.cn/gnosis-safe/safe-contracts/src/commit/186a21a74b327f17fc41217a927dea7064f74604/contracts/proxies/GnosisSafeProxyFactory.sol#L48)，发现其只是一个用来将合约地址随机化的盐，其具体作用机制我们稍后再讲。

### setup 概览

解析 initializer 的内容，可得 setup 的实参为：

```text
_owners          [0xe0cab803e4635e50ee2f27d77b2543df55379413, 0x74a6a114a128b67b738581e3660655643f49fb99]
_threshold       2
to               0x0000000000000000000000000000000000000000
data             0x
fallbackHandler  0xf48f2b2d2a534e402487b3ee7c18c33aec0fe5e4
paymentToken     0x0000000000000000000000000000000000000000
payment          0
paymentReceiver  0x0000000000000000000000000000000000000000
```

未完
