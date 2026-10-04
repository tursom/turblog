"""Space/time maze strategy experiments. CPython-only simulation.
Integer cache entry counts are reported rather than assumed game memory bytes.
"""
import random
import json
from collections import deque
from pathlib import Path
from maze_lazy_benchmark import Explorer, maze, N, V, NEIGHBORS
from maze_tick_benchmark import PROFILES, COMMON_API_TICKS


class MemoryExplorer(Explorer):
    def __init__(self, strategy):
        super().__init__('lazy_dfs')
        self.strategy=strategy
        self.parent={0:None};self.depth={0:0}
        self.routes={}
        self.target_cache={}
        self.cache_entries=0
        self.stats.update(tree_steps=0,cache_hits=0,cache_lookups=0,
                          cache_writes=0,cache_entries_peak=0)
    def step(self,v,actual):
        u=self.pos
        super().step(v,actual)
        if v not in self.parent:
            self.parent[v]=u;self.depth[v]=self.depth[u]+1
            self.stats['cache_writes']+=2
    def tree_route(self,target):
        u=self.pos;v=target;up=[];down=[]
        while self.depth[u]>self.depth[v]:
            u=self.parent[u];up.append(u);self.stats['tree_steps']+=1
        while self.depth[v]>self.depth[u]:
            down.append(v);v=self.parent[v];self.stats['tree_steps']+=1
        while u!=v:
            u=self.parent[u];up.append(u)
            down.append(v);v=self.parent[v];self.stats['tree_steps']+=2
        return up+down[::-1]
    def execute(self,path,actual):
        for v in path:
            self.probe(actual)
            self.step(v,actual)
        self.probe(actual)
    def cache_peak(self):
        self.stats['cache_entries_peak']=max(self.stats['cache_entries_peak'],self.cache_entries)
    def target_route(self,target):
        self.stats['cache_lookups']+=1
        cached=self.target_cache.get(target)
        if cached is not None and self.pos in cached:
            self.stats['cache_hits']+=1
            hops=cached
        else:
            # Cache target-rooted next-hop routing; old passages remain valid.
            # Newly opened edges do not invalidate this cache, but may shorten routes.
            self.stats['bfs']+=1
            hops={target:target};q=deque([target])
            while q:
                u=q.popleft();self.stats['queue_pops']+=1
                for v in NEIGHBORS[u]:
                    self.stats['edge_checks']+=1
                    if v in self.g[u] and v not in hops:
                        hops[v]=u;q.append(v)
            assert self.pos in hops
            if cached is not None:self.cache_entries-=len(cached)
            self.target_cache[target]=hops
            self.cache_entries+=len(hops);self.stats['cache_writes']+=len(hops)
            self.cache_peak()
        route=[];u=self.pos
        while u!=target:
            u=hops[u];route.append(u);self.stats['tree_steps']+=1
        return route
    def seek(self,target,actual):
        self.lazy_dfs(target,actual)
        if self.pos==target:return
        if self.strategy!='tree':
            short=self.shortcut(target)
            if short is not None:
                self.stats['shortcuts']+=1
                self.execute(short,actual);assert self.pos==target;return
        if self.strategy=='target_cache':
            path=self.target_route(target)
        elif self.strategy=='pair_cache':
            key=(self.pos,target)
            self.stats['cache_lookups']+=1
            if key in self.routes:
                path=self.routes[key];self.stats['cache_hits']+=1
            else:
                path=self.tree_route(target)
                # Cache both directions. O(path length) memory writes are charged.
                self.routes[key]=path[:]
                self.routes[(target,self.pos)]=([self.pos]+path[:-1])[::-1]
                self.cache_entries+=2*len(path);self.stats['cache_writes']+=2*len(path)
                self.cache_peak()
        else:path=self.tree_route(target)
        if self.strategy=='tree_chords':
            # Index the tree route once; use known edges to skip forward along it.
            # Each jump strictly advances, so it cannot loop or lose reachability.
            order={node:i for i,node in enumerate(path)}
            self.stats['cache_writes']+=len(order)
            self.stats['cache_entries_peak']=max(self.stats['cache_entries_peak'],len(order))
            cursor=-1
            while cursor<len(path)-1:
                self.probe(actual)
                chosen=cursor+1
                for v in NEIGHBORS[self.pos]:
                    self.stats['edge_checks']+=1
                    if v in self.g[self.pos] and v in order and order[v]>chosen:
                        chosen=order[v]
                self.step(path[chosen],actual)
                cursor=chosen
            self.probe(actual)
        else:self.execute(path,actual)
        assert self.pos==target


def scores(stats):
    result={}
    for name,profile in PROFILES.items():
        # Estimated game statement costs, not measured interpreter ticks.
        scale={'lean':1,'central':2,'heavy':4}[name]
        cost=COMMON_API_TICKS+sum(stats[k]*w for k,w in profile.items())
        cost+=stats.get('tree_steps',0)*6*scale
        cost+=stats.get('cache_lookups',0)*3*scale
        cost+=stats.get('cache_writes',0)*2*scale
        result[name]=cost
    return result


def run(seeds=8):
    output=[]
    for removed in [0,1,4,16]:
        rows=[]
        for seed in range(seeds):
            rng=random.Random(seed);actual=maze(rng)
            base=Explorer('lazy_dfs')
            strategies={'dfs_incremental':base}
            for name in ['tree','tree_shortcut','tree_chords','pair_cache','target_cache']:
                strategies[name]=MemoryExplorer(name)
            walls=[(u,v) for u in range(V) for v in NEIGHBORS[u] if u<v and v not in actual[u]]
            rng.shuffle(walls)
            for round_id in range(301):
                if round_id:
                    for _ in range(min(removed,len(walls))):
                        u,v=walls.pop();actual[u].add(v);actual[v].add(u)
                target=rng.randrange(V)
                for name,solver in strategies.items():
                    solver.seek(target,actual)
                    assert solver.pos==target
                    if round_id==0:solver.stats['first_moves']=solver.stats['moves']
            for name,solver in strategies.items():
                rows.append(dict(seed=seed,strategy=name,stats=solver.stats,
                                 tick_estimates=scores(solver.stats),
                                 tree_entries=2*len(getattr(solver,'parent',{}))))
        summaries={}
        for name in strategies:
            group=[r for r in rows if r['strategy']==name]
            keys=group[0]['stats'].keys()
            summaries[name]={k:sum(r['stats'][k] for r in group)/seeds for k in keys}
            summaries[name]['ticks']={p:sum(r['tick_estimates'][p] for r in group)/seeds for p in PROFILES}
        output.append(dict(removed=removed,seeds=seeds,averages=summaries,runs=rows))
    return output

if __name__=='__main__':
    result=run()
    Path('maze_memory_benchmark_results.json').write_text(json.dumps(result,indent=2)+'\n')
    for r in result:
        print('removed',r['removed'])
        for name,s in r['averages'].items():
            print(name,'moves',round(s['moves']), 'ticks(M)',{k:round(v/1e6,3) for k,v in s['ticks'].items()},
                  'peak extra entries',round(s.get('cache_entries_peak',0)), 'hits',round(s.get('cache_hits',0),1))
