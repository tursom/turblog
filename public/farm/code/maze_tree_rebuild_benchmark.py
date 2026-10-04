"""Amortize map optimization: occasionally rebuild the spanning tree with BFS."""
from collections import deque
from pathlib import Path
import json
import random
from maze_memory_benchmark import MemoryExplorer, scores
from maze_lazy_benchmark import maze,N,V,NEIGHBORS

class RebuildTree(MemoryExplorer):
    def __init__(self,interval):
        super().__init__('tree_chords');self.interval=interval
        self.rounds=0;self.dirty=False
        self.stats.update(rebuilds=0,rebuild_checks=0)
    def probe(self,actual):
        added=super().probe(actual)
        if added:self.dirty=True
        return added
    def rebuild(self):
        root=self.pos;parent={root:None};depth={root:0};q=deque([root])
        self.stats['bfs']+=1;self.stats['rebuilds']+=1
        while q:
            u=q.popleft();self.stats['queue_pops']+=1
            for v in NEIGHBORS[u]:
                self.stats['edge_checks']+=1
                if v in self.g[u] and v not in parent:
                    parent[v]=u;depth[v]=depth[u]+1;q.append(v)
                    self.stats['cache_writes']+=2
        self.parent=parent;self.depth=depth;self.dirty=False
    def seek(self,target,actual):
        if self.interval:
            self.stats['rebuild_checks']+=1
            if self.rounds and self.rounds%self.interval==0 and self.dirty:self.rebuild()
        super().seek(target,actual)
        self.rounds+=1

def run(seeds, start_seed=0, intervals=None):
 if intervals is None:
  intervals=[0,8,32,64]
 if 0 not in intervals:
  intervals=[0]+intervals
 results=[]
 for removed in [0,1,4,16]:
  runs=[]
  for seed in range(start_seed,start_seed+seeds):
   rng=random.Random(seed);actual=maze(rng)
   workers={i:RebuildTree(i) for i in intervals}
   walls=[(u,v) for u in range(V) for v in NEIGHBORS[u] if u<v and v not in actual[u]];rng.shuffle(walls)
   for turn in range(301):
    if turn:
     for _ in range(min(removed,len(walls))):
      u,v=walls.pop();actual[u].add(v);actual[v].add(u)
    target=rng.randrange(V)
    for w in workers.values():w.seek(target,actual);assert w.pos==target
   for interval,w in workers.items():
    ticks=scores(w.stats)
    for p,scale in [('lean',1),('central',2),('heavy',4)]:ticks[p]+=6*scale*w.stats['rebuild_checks']
    runs.append(dict(seed=seed,interval=interval,stats=w.stats,ticks=ticks))
  summary={}
  for interval in workers:
   group=[r for r in runs if r['interval']==interval]
   summary[interval]=dict(moves=sum(r['stats']['moves'] for r in group)/seeds,rebuilds=sum(r['stats']['rebuilds'] for r in group)/seeds,ticks={p:sum(r['ticks'][p] for r in group)/seeds for p in ['lean','central','heavy']},wins={p:sum(r['ticks'][p]<next(b['ticks'][p] for b in runs if b['seed']==r['seed'] and b['interval']==0) for r in group) for p in ['lean','central','heavy']})
  results.append(dict(removed=removed,seeds=seeds,averages=summary,runs=runs))
 return results

if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--seeds',type=int,default=24)
 p.add_argument('--start',type=int,default=0);p.add_argument('--output',default='maze_tree_rebuild_benchmark_results.json')
 p.add_argument('--intervals',default='0,8,32,64')
 args=p.parse_args()
 results=run(args.seeds,args.start,[int(v) for v in args.intervals.split(',')])
 Path(args.output).write_text(json.dumps(results,indent=2)+'\n')
 for row in results:
  print('walls',row['removed'])
  for i,s in row['averages'].items():print(i,round(s['moves']),round(s['rebuilds']),{p:round(t/1e6,3) for p,t in s['ticks'].items()},s['wins'])
