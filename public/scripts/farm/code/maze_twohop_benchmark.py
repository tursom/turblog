"""Cheap two-edge lookahead, paired against the current one-edge shortcut model."""
import json
import random
from pathlib import Path
from maze_memory_benchmark import MemoryExplorer, scores
from maze_lazy_benchmark import maze, N, V, NEIGHBORS


class TwoHop(MemoryExplorer):
    def __init__(self,interval):
        super().__init__('tree_chords');self.interval=interval
        self.stats.update(lookahead=0,success=0,trigger_checks=0,candidate_scores=0)
    def seek(self,target,actual):
        self.lazy_dfs(target,actual)
        if self.pos==target:return
        direct=self.shortcut(target)
        if direct is not None:
            self.stats['shortcuts']+=1;self.execute(direct,actual);return
        path=self.tree_route(target);order={v:i for i,v in enumerate(path)}
        self.stats['cache_writes']+=len(order)
        cursor=-1;cooldown=0
        while cursor<len(path)-1:
            self.probe(actual)
            chosen=cursor+1
            for v in NEIGHBORS[self.pos]:
                self.stats['edge_checks']+=1
                if v in self.g[self.pos] and v in order and order[v]>chosen:chosen=order[v]
            middle=None;end=chosen;best_gain=chosen-cursor-1
            if self.interval:
                self.stats['trigger_checks']+=1
                if cooldown<=0 and chosen==cursor+1 and len(path)-cursor>4:
                    self.stats['lookahead']+=1
                    cooldown=self.interval
                    for v in NEIGHBORS[self.pos]:
                        self.stats['edge_checks']+=1
                        # A forward route neighbor will be visited anyway. Look off-route.
                        if v not in self.g[self.pos] or v in order:continue
                        for w in NEIGHBORS[v]:
                            self.stats['edge_checks']+=1
                            if w in self.g[v] and w in order:
                                self.stats['candidate_scores']+=1
                                gain=order[w]-cursor-2
                                if gain>best_gain:
                                    best_gain=gain;middle=v;end=order[w]
            if middle is not None:
                self.step(middle,actual);self.probe(actual)
                self.stats['success']+=1
            self.step(path[end],actual);cursor=end;cooldown-=1
        self.probe(actual)
        assert self.pos==target


def cost(stats):
    out=scores(stats)
    for p,scale in [('lean',1),('central',2),('heavy',4)]:
        out[p]+=scale*(4*stats['trigger_checks']+6*stats['candidate_scores'])
    return out


def run(seeds=24):
    rows=[]
    for removed in [0,1,4,16]:
        runs=[]
        for seed in range(seeds):
            rng=random.Random(seed);actual=maze(rng)
            workers={i:TwoHop(i) for i in [0,1,4,8]}
            walls=[(u,v) for u in range(V) for v in NEIGHBORS[u] if u<v and v not in actual[u]]
            rng.shuffle(walls)
            for episode in range(301):
                if episode:
                    for _ in range(min(removed,len(walls))):
                        u,v=walls.pop();actual[u].add(v);actual[v].add(u)
                target=rng.randrange(V)
                for worker in workers.values():
                    worker.seek(target,actual);assert worker.pos==target
            for interval,w in workers.items():runs.append(dict(seed=seed,interval=interval,stats=w.stats,ticks=cost(w.stats)))
        averages={}
        for interval in workers:
            group=[r for r in runs if r['interval']==interval]
            averages[interval]={'moves':sum(r['stats']['moves'] for r in group)/seeds,
                'hits':sum(r['stats']['success'] for r in group)/seeds,
                'ticks':{p:sum(r['ticks'][p] for r in group)/seeds for p in ['lean','central','heavy']},
                'wins':{p:sum(r['ticks'][p]<next(b['ticks'][p] for b in runs if b['seed']==r['seed'] and b['interval']==0) for r in group) for p in ['lean','central','heavy']}}
        rows.append(dict(removed=removed,seeds=seeds,averages=averages,runs=runs))
    return rows

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--seeds',type=int,default=24)
    results=run(parser.parse_args().seeds)
    Path('maze_twohop_benchmark_results.json').write_text(json.dumps(results,indent=2)+'\n')
    for r in results:
        print('removed',r['removed'])
        for i,s in r['averages'].items():
            print(i,round(s['moves']),round(s['hits']),{p:round(v/1e6,3) for p,v in s['ticks'].items()},s['wins'])
