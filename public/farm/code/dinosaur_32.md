# 独立贪吃蛇脚本

`dinosaur_32.py` 已采用经过模拟验证的轻量捷径实现。把整个文件复制到《The Farmer Was Replaced》中运行即可；需要 32×32 农场、已解锁恐龙，以及足够支付整局苹果的材料。

每局开始和结束都会清空农场，运行前应停止其他无人机。脚本连续刷骨头；资源不足、未解锁恐龙或遇到增长死路时停止。结束一局时换回草帽收获，再清场。

## 当前实现

- 启动时生成方向、邻居和环跨度查找表，多局复用。
- 蛇身短于 `DINO_SHORTCUT_LIMIT = 512` 时，保持原版的安全最大跨度捷径策略。
- 使用环形队列维护身体环编号，避免 `pop(0)` 和重复的占用字典检查。
- 达到 512 后直接沿完整回路批量移动，不再维护软件蛇身队列。

本次替换的是独立脚本，`farm_32_all_in_one.py` 未修改。旧独立版本完整保存在 `dinosaur_32_baseline.py`，供历史结果复核和后续对比。生产脚本与 `dinosaur_32_shortcut_experiment.py` 的代码 AST 一致，仅文件头说明不同。

## 已知限制

原策略的增长死路仍然存在。例如从 `(0,0)` 直接走捷径到苹果 `(0,1)` 后，下一颗苹果位于 `(1,0)` 时可能无法继续增长。因此这版优化不保证每局都填满；遇到死路会收尾并停止，不会继续使用失败后的队列状态。

## 验证与性能

20 个随机种子的模拟中，原版与轻量版全部填满，每颗苹果的移动步数一致。单独的逐步轨迹测试、队列回绕、511→512 切换、已知死路，以及生产入口的资源检查和换帽清场流程均有自动化验证。

| 平均每局 | 原版 | 当前轻量版 |
| --- | ---: | ---: |
| 移动步数 | 132,799 | 132,799 |
| 算法主体预计 tick | 97,389,216 | 7,515,989 |

轻量版预计少用约 92.3% tick，查找表的一次性构建另需约 227,481 tick。以上来自公开规则建立的成本模型，尚未在本机游戏引擎中确认，公共外层循环、清场和换帽费用未计入。

复跑测试及三方 tick 对比：

```bash
python -B -m unittest -v dinosaur_tick_model_test dinosaur_tick_benchmark_test dinosaur_shortcut_experiment_test
python -B dinosaur_tick_model.py --seeds 20 --size 32 --include-light --output /tmp/dinosaur_production_ticks.json
```

模型中的 `old` 指 `dinosaur_32_baseline.py`，`new` 指完整回路实验，`light` 指当前生产脚本。原有 `dinosaur_benchmark.py` 和游戏内 `dinosaur_tick_benchmark.py` 仍用于旧基线与完整回路的比较。

实现与模拟细节见 [dinosaur_shortcut_experiment.md](dinosaur_shortcut_experiment.md)；tick 规则和原生 `simulate()` 入口说明见 [dinosaur_tick_model.md](dinosaur_tick_model.md)。
