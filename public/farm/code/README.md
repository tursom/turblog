# 编程农场脚本

《The Farmer Was Replaced》（编程农场）的游戏脚本、本地模拟和实验记录。网站入口为 `/farm/`，按综合种植、仙人掌、恐龙、迷宫分组，每个主要游戏脚本都有说明、源码与下载。

这些文件从仓库根目录集中归档，保留原文件名与同目录依赖。整理时未修改算法或重新生成历史结果。说明由 AI 辅助整理。

## 从哪里开始

| 用途       | 入口                                                 | 说明                                                       |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| 综合农场   | [farm_32_all_in_one.py](farm_32_all_in_one.py)       | 32×32 分区种植与自动解锁；先创建 `maze_reuse` 游戏代码窗口 |
| 胡萝卜混种 | [carrot_polyculture_32.py](carrot_polyculture_32.py) | 默认目标库存 1000 万，顶部可修改；启动会清场               |
| 仙人掌单机 | [cactus_32.py](cactus_32.py)                         | 列双向扫描、行插入排序                                     |
| 仙人掌多机 | [cactus_32_multi.py](cactus_32_multi.py)             | 按无人机上限划分条带；需要空闲无人机，数量需整除 32        |
| 独立刷骨头 | [dinosaur_32.py](dinosaur_32.py)                     | 当前轻量捷径版，使用前阅读 [实现说明](dinosaur_32.md)      |
| 复用迷宫   | [maze_reuse.py](maze_reuse.py)                       | 当前模块，按需探索并默认每 64 次搬迁检查树重建             |

游戏脚本调用游戏内置 API，不能直接用普通 Python 运行。种植与恐龙脚本面向 32×32 农场；迷宫模块按实际地图尺寸计算。需要解锁脚本用到的作物、容器、感知、浇水等 API，并准备足够的材料。运行前停止其他脚本和无人机；上述入口都可能清空或重种农场。综合脚本和多机仙人掌还需要无人机能力。

综合脚本按固定分区持续种植，`*_RESERVE` 是购买科技后应保留的库存底线，并非通用补货目标。金币和骨头阶段由待解锁科技的费用触发；目标科技全部解锁后，只继续种植，不再进入这两个阶段。

综合脚本需要把 `maze_reuse.py` 保存到游戏的 `maze_reuse` 窗口，再运行综合脚本。单独使用迷宫模块时，在另一个游戏代码窗口执行：

```python
import maze_reuse
maze_reuse.run_maze_batch(100000)
```

参数是金币**总库存目标**。导入模块本身不会开始工作，迷宫运行期间必须由单架无人机独占全场。

## 版本与对照

- 仙人掌：`cactus_32_insertion.py` 的行列都使用插入排序；`cactus_32_planned.py` 先扫描全图再规划搬移；`cactus_32_multi.py` 使用多无人机条带。尚无统一游戏实测排名。
- 恐龙：`dinosaur_32_baseline.py` 保存旧捷径基线，`dinosaur_32_full_cycle_experiment.py` 沿完整回路移动；`dinosaur_32_shortcut_experiment.py` 是已采用的轻量优化实验，与当前 `dinosaur_32.py` 的代码 AST 一致。综合脚本内部仍是旧恐龙策略。
- 迷宫：`maze_reuse_bfs.py` 先探索全图再用 BFS 导航；`maze_reuse_tree_static.py` 复用初始树、不做周期重建。用作替代模块时，仍保存为游戏窗口名 `maze_reuse`，保留同一调用接口。

当前恐龙轻量版**仍保留增长死路**，不能保证每局填满。起点 `(0,0)`，后续苹果依次为 `(0,1)` 和 `(1,0)` 是已知反例。轻量版遇到死路会收尾停止；不要把 20 个随机种子全部填满解读为普遍保证。

## 本地测试与模拟

本地工具使用 CPython 3.9+ 和标准库。克隆仓库后从本目录运行，保持全部文件同目录；迷宫测试及部分成本模型会按**当前工作目录**读取其他文件。

```bash
cd public/farm/code
python -B -m unittest -v dinosaur_tick_model_test dinosaur_tick_benchmark_test dinosaur_shortcut_experiment_test
python -B maze_reuse_runtime_test.py
```

三方恐龙 tick 成本模型可以这样复跑（完整 20 种子模拟可能耗时较长）：

```bash
python -B dinosaur_tick_model.py --seeds 20 --size 32 --include-light --output /tmp/dinosaur_ticks.json
```

模型中 `old` 是旧基线，`new` 是完整回路实验，`light` 读取当前独立主脚本。细节见 [轻量捷径实验](dinosaur_shortcut_experiment.md) 和 [tick 成本模型](dinosaur_tick_model.md)。

本地迷宫基准包括 `maze_reuse_benchmark.py`、`maze_lazy_benchmark.py`、`maze_tick_benchmark.py`、`maze_memory_benchmark.py`、`maze_local_benchmark.py`、`maze_twohop_benchmark.py`、`maze_tree_rebuild_benchmark.py`、`maze_staged_benchmark.py`。它们覆盖不同建图、搜索和重建策略；部分默认输出会覆盖同名 JSON，复跑前检查输出设置。`maze_tick_benchmark.py` 读取当前目录中的 `maze_lazy_benchmark_results.json`。

## 游戏内验证工具

以下文件也需要游戏 API，不是 CPython 测试：

| 文件                                                        | 如何运行                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `dinosaur_tick_benchmark.py`                                | 直接在游戏内运行，比较旧基线与完整回路；会清场并消耗真实苹果材料          |
| `dinosaur_simulate_benchmark.py` + `dinosaur_sim_worker.py` | 先创建同名 worker 窗口，再运行 driver；使用六参数 `simulate()` 和虚拟库存 |
| `maze_wall_simulate.py` + `maze_wall_probe.py`              | 先创建同名 probe 窗口，再运行 driver；采样游戏迷宫墙体变化                |

worker/probe 的参数由 driver 注入，不应单独启动。`simulate()` 返回模拟游戏秒数，不是 tick；tick 应读取 worker 的 `get_tick_count()` 输出。当前恐龙原生 A/B 工具只比较旧基线与完整回路，尚未包含轻量版。

## 历史结果的范围

目录中 15 份 JSON 是历史模拟快照。恐龙的主要 20 种子结果支持“轻量版移动步数不变、算法主体预计 tick 较旧版减少约 92.3%”，但这是成本模型估算，未经游戏引擎实测确认；不包含公共外层循环、清场和换帽费用。

JSON 中的源文件哈希、模型版本、绝对路径和状态描述记录的是当时的运行环境。归档后路径可能不再存在，旧状态也可能已经变化；不能将这些附件当成当前模型重新生成的结果。迷宫的移墙数量是人工模型参数，不是游戏实际规律，各结果文件的种子数和策略参数也不完全相同。
