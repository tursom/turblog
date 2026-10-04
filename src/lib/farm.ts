import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const farmGroups = [
  {
    id: 'crops',
    title: '综合种植',
    summary: '按固定分区持续种植，按科技需求补充特殊资源，另有独立胡萝卜混种脚本。',
    notes: [
      '这些脚本面向 32×32 农场。先检查文件顶部的库存储备、水位和科技设置，再在游戏代码窗口运行。',
      '综合脚本会自动尝试解锁科技，并在升级阶段需要金币或骨头时进入独占全场的阶段、清空农场。启动前停止其他脚本和无人机。',
    ],
  },
  {
    id: 'cactus',
    title: '仙人掌',
    summary: '整田种植、行列排序与连锁收获，保留四种实现供比较。',
    notes: [
      '四个版本都按 32×32 编写，需要仙人掌和足够的种植材料；每轮会清场重种。多机条带版还需要相应的无人机能力。',
      '各版本采用不同的排序和调度方式。目前没有统一的游戏内计时结论，可从基础版开始，再按无人机数量选择多机版。',
    ],
  },
  {
    id: 'dinosaur',
    title: '恐龙与骨头',
    summary: '贪吃蛇式收集苹果，包含当前轻量捷径、旧基线和完整回路实验。',
    notes: [
      '独立脚本需要 32×32 农场、恐龙科技和足够支付一局苹果的材料；每局开始与结束都会清场，运行前停止其他无人机。',
      '当前轻量捷径保留了原策略的增长死路，不保证每局填满。起点 (0,0)、苹果依次为 (0,1) 和 (1,0) 就是已知反例；遇到死路后收尾并停止。',
      '20 个随机种子的本地模型中，轻量版与旧版移动步数一致，算法主体预计 tick 减少约 92.3%。这是成本模型估算，尚未由游戏引擎实测确认；综合脚本中的恐龙实现仍是旧策略。',
    ],
  },
  {
    id: 'maze',
    title: '迷宫与金币',
    summary: '复用迷宫地图与宝藏搬迁，比较按需探索、树路径和 BFS。',
    notes: [
      'maze_reuse 是供其他脚本导入的模块，导入本身不会开始工作。综合种植脚本会调用它，也可以在单独的游戏代码窗口调用 run_maze_batch(金币库存目标)。',
      '需要迷宫科技和奇异物质；运行会清场，且必须让单架无人机独占迷宫。当前版默认每 64 次搬迁检查是否需要重建路径树。',
      '本地随机迷宫测试与游戏内墙体采样属于不同的验证环境，历史结果不能直接当作当前游戏版本的实测性能。',
    ],
  },
] as const;

export type FarmGroup = (typeof farmGroups)[number];

export interface FarmScript {
  slug: string;
  file: string;
  group: FarmGroup['id'];
  title: string;
  version: string;
  summary: string;
  usage: string[];
}

export const farmScripts: FarmScript[] = [
  {
    slug: 'all-in-one',
    file: 'farm_32_all_in_one.py',
    group: 'crops',
    title: '32×32 综合农场',
    version: '综合入口',
    summary: '管理基础作物、南瓜、仙人掌和向日葵，并在科技升级阶段按需求生产金币与骨头。',
    usage: [
      '先把 maze_reuse.py 保存到游戏中的 maze_reuse 代码窗口，再复制本文件到另一个窗口运行。',
      '顶部的 HAY_RESERVE、WOOD_RESERVE、CARROT_RESERVE 等常量用于限制购买科技后应保留的库存，并不是通用补货目标。TARGET_TECHS 决定自动解锁目标；基础作物按固定分区持续生产。',
      '目标科技全部解锁后，脚本会持续执行种植轮次，不再进入金币或骨头阶段。此时需要补充这些资源，可使用独立脚本或迷宫模块。',
      '恐龙阶段尚未合入独立轻量版优化；专门刷骨头时可使用 dinosaur_32.py。',
    ],
  },
  {
    slug: 'carrot-polyculture',
    file: 'carrot_polyculture_32.py',
    group: 'crops',
    title: '胡萝卜混种',
    version: '独立脚本',
    summary: '维护胡萝卜与伴生植物，达到目标库存后结束。',
    usage: [
      '需要胡萝卜与混种科技。调整顶部 CARROT_TARGET 后复制完整文件到游戏中运行；启动会清空农场，之后根据伴生需求替换地块。',
    ],
  },
  {
    slug: 'cactus',
    file: 'cactus_32.py',
    group: 'cactus',
    title: '仙人掌基础版',
    version: '基础版',
    summary: '单机种植，以双向扫描排序各列、插入排序整理各行，最后触发整田连锁收获。',
    usage: ['复制完整文件到游戏中运行。材料充足时持续循环；种植与排序都由单架无人机完成。'],
  },
  {
    slug: 'cactus-insertion',
    file: 'cactus_32_insertion.py',
    group: 'cactus',
    title: '仙人掌插入排序版',
    version: '对照版',
    summary: '用相邻交换执行行列插入排序，保留为直观的排序对照。',
    usage: [
      '使用方式与基础版相同，由单架无人机完成种植与排序。比较时保持科技、库存与能量条件一致。',
    ],
  },
  {
    slug: 'cactus-planned',
    file: 'cactus_32_planned.py',
    group: 'cactus',
    title: '仙人掌预规划版',
    version: '实验版',
    summary: '扫描整田数值，在内存中生成放置计划，再执行交换。',
    usage: [
      '复制完整文件到游戏中运行。规划也有语言操作成本，减少某些移动并不等于游戏 tick 一定更少。',
    ],
  },
  {
    slug: 'cactus-multi',
    file: 'cactus_32_multi.py',
    group: 'cactus',
    title: '仙人掌多机条带版',
    version: '多机版',
    summary: '按可用无人机上限划分条带，并行种植、排好各列与各行。',
    usage: [
      '按 max_drones() 分配任务，最多使用 32 架无人机；假定科技解锁的数量是能整除 32 的二次幂。启动前停止其他无人机，保证分配的工作无人机可用。',
    ],
  },
  {
    slug: 'dinosaur',
    file: 'dinosaur_32.py',
    group: 'dinosaur',
    title: '恐龙轻量捷径',
    version: '当前独立版',
    summary: '预计算路径表、用环形队列维护蛇身，长度达到 512 后直接沿完整回路移动。',
    usage: [
      '复制完整文件到游戏中运行，脚本会连续刷骨头。资源不足、科技未解锁或遇到增长死路时停止。',
      'DINO_SHORTCUT_LIMIT 默认 512；已有验证以这个阈值为准。详细模型、测试与历史结果见本主题的辅助文件。',
    ],
  },
  {
    slug: 'dinosaur-baseline',
    file: 'dinosaur_32_baseline.py',
    group: 'dinosaur',
    title: '恐龙原版捷径',
    version: '历史基线',
    summary: '保留优化前的独立版本，使用列表与占用字典维护蛇身。',
    usage: ['用于复核旧结果和算法对比。成本模型中的 old 读取这个文件；它也保留原策略的增长死路。'],
  },
  {
    slug: 'dinosaur-full-cycle',
    file: 'dinosaur_32_full_cycle_experiment.py',
    group: 'dinosaur',
    title: '恐龙完整回路',
    version: '实验版',
    summary: '沿预先生成的完整回路前进，用较多移动换取更低的逐步计算开销。',
    usage: [
      '可作为独立游戏脚本运行。成本模型中的 new 指这个版本，原生 A/B 测试也用它与旧基线比较。',
    ],
  },
  {
    slug: 'dinosaur-shortcut-experiment',
    file: 'dinosaur_32_shortcut_experiment.py',
    group: 'dinosaur',
    title: '恐龙轻量捷径实验快照',
    version: '已采用的实验',
    summary: '保存轻量优化的实验来源，目前与独立主脚本的代码 AST 一致。',
    usage: ['保留用于追溯实验过程。日常使用选择 dinosaur_32.py；两者只是文件头说明不同。'],
  },
  {
    slug: 'maze-reuse',
    file: 'maze_reuse.py',
    group: 'maze',
    title: '迷宫按需探索与树重建',
    version: '当前模块',
    summary: '按需发现路径，优先使用直达路线或树路径，定期根据新发现的通道重建树。',
    usage: [
      '在游戏中保存为 maze_reuse，由综合脚本导入。单独使用时也须在另一个代码窗口导入模块并调用 run_maze_batch。',
      '参数是目标金币总库存，并非要新增的金币数。TREE_REBUILD_INTERVAL 设为 0 可禁用周期重建。',
    ],
  },
  {
    slug: 'maze-bfs',
    file: 'maze_reuse_bfs.py',
    group: 'maze',
    title: '迷宫全图 BFS',
    version: '对照模块',
    summary: '先探索整张地图，再从目标反向计算距离并选择移动方向。',
    usage: [
      '与其他迷宫模块使用同一 run_maze_batch 接口。测试替换时，把本文件内容保存到游戏的 maze_reuse 窗口；不要同时运行多个版本。',
    ],
  },
  {
    slug: 'maze-tree-static',
    file: 'maze_reuse_tree_static.py',
    group: 'maze',
    title: '迷宫静态树路径',
    version: '对照模块',
    summary: '按需探索并复用初始路径树，不做周期性树重建。',
    usage: ['接口与当前模块相同。作为对照时，用本文件替换游戏中 maze_reuse 窗口的内容。'],
  },
];

const codeDirectory = resolve('public/scripts/farm/code');
const nativeTools: Record<string, string> = {
  'dinosaur_tick_benchmark.py': '游戏内 A/B 计时：会清场并消耗真实材料；比较旧基线与完整回路',
  'dinosaur_simulate_benchmark.py': '游戏原生模拟入口：先创建 dinosaur_sim_worker 窗口',
  'dinosaur_sim_worker.py': '原生模拟 worker：由 driver 注入参数，不直接运行',
  'maze_wall_simulate.py': '游戏内墙体采样入口：先创建 maze_wall_probe 窗口',
  'maze_wall_probe.py': '墙体采样 worker：由 maze_wall_simulate 启动，不直接运行',
};

export function getSupportingFiles(group: FarmGroup['id']) {
  const scriptFiles = new Set(farmScripts.map((script) => script.file));
  return readdirSync(codeDirectory)
    .filter(
      (file) =>
        file.startsWith(`${group}_`) && !scriptFiles.has(file) && /\.(py|md|json)$/.test(file),
    )
    .sort()
    .map((file) => ({
      file,
      description:
        nativeTools[file] ??
        (file.endsWith('.md')
          ? '实现说明与验证记录（Markdown）'
          : file.endsWith('.json')
            ? '历史模拟结果（JSON，运行条件见文件内容）'
            : file.endsWith('_test.py')
              ? '本地 Python 测试'
              : '本地 Python 模型或基准测试'),
    }));
}

export function readFarmSource(script: FarmScript) {
  return readFile(resolve(codeDirectory, script.file), 'utf8');
}
