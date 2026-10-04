"""Compare fixed and staged tree-rebuild schedules on paired maze scenarios."""
import random
import json
from pathlib import Path
from maze_tree_rebuild_benchmark import RebuildTree
from maze_memory_benchmark import MemoryExplorer, scores
from maze_lazy_benchmark import maze, N, V, NEIGHBORS

# Entries: completed relocations threshold, interval from the last checkpoint.
SCHEDULES={
    'fixed32':[(0,32)],
    'fixed64':[(0,64)],
    '8_32_64':[(0,8),(64,32),(160,64)],
    '16_32_64':[(0,16),(64,32),(160,64)],
    '24_48_96':[(0,24),(64,48),(160,96)],
    '32_64_128':[(0,32),(64,64),(160,128)],
}

class StagedTree(RebuildTree):
    def __init__(self,schedule):
        super().__init__(0)
        self.schedule=schedule;self.checkpoint=0
        self.stats.update(schedule_checks=0)
        self.rebuild_times=[]
    def seek(self,target,actual):
        interval=self.schedule[0][1]
        for threshold,value in self.schedule:
            self.stats['schedule_checks']+=1
            if self.rounds>=threshold:interval=value
        self.stats['rebuild_checks']+=1
        if self.rounds-self.checkpoint>=interval:
            self.checkpoint=self.rounds
            if self.dirty:
                self.rebuild();self.rebuild_times.append(self.rounds)
        MemoryExplorer.seek(self,target,actual)
        self.rounds+=1


def run(seeds,start):
    result=[]
    for removed in [0,1,4,16]:
        runs=[]
        for seed in range(start,start+seeds):
            rng=random.Random(seed);actual=maze(rng)
            workers={name:StagedTree(schedule) for name,schedule in SCHEDULES.items()}
            walls=[(u,v) for u in range(V) for v in NEIGHBORS[u] if u<v and v not in actual[u]]
            rng.shuffle(walls)
            for turn in range(301):
                if turn:
                    for _ in range(min(removed,len(walls))):
                        u,v=walls.pop();actual[u].add(v);actual[v].add(u)
                target=rng.randrange(V)
                for w in workers.values():w.seek(target,actual);assert w.pos==target
            for name,w in workers.items():
                ticks=scores(w.stats)
                for p,scale in [('lean',1),('central',2),('heavy',4)]:
                    ticks[p]+=scale*(6*w.stats['rebuild_checks']+3*w.stats['schedule_checks'])
                runs.append(dict(seed=seed,strategy=name,stats=w.stats,ticks=ticks,rebuild_times=w.rebuild_times))
        result.append(dict(removed=removed,seeds=seeds,runs=runs))
    return result

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--seeds',type=int,default=8);p.add_argument('--start',type=int,default=0);p.add_argument('--output',required=True)
    args=p.parse_args()
    Path(args.output).write_text(json.dumps(run(args.seeds,args.start),indent=2)+'\n')
