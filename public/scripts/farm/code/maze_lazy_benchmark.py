"""Compare full mapping against lazy exploration, including initial mapping.
Run with CPython, not inside the game. Uses the same generated scenarios for all solvers.
"""
import json
from collections import deque
from maze_reuse_benchmark import N, V, NEIGHBORS, Solver, maze
import random


def manhattan(a,b):
    return abs(a%N-b%N)+abs(a//N-b//N)


class Explorer(Solver):
    def __init__(self, method):
        super().__init__([set() for _ in range(V)], True)
        self.method=method
        self.explored=set()
        self.stats.update(first_moves=0, first_checks=0, frontier_scores=0)

    def probe(self,actual):
        self.explored.add(self.pos)
        return super().probe(actual)

    def step(self,v,actual):
        assert v in actual[self.pos]
        self.pos=v
        self.stats['moves']+=1

    def map_all(self,actual):
        self.probe(actual)
        seen={self.pos};stack=[self.pos]
        while stack:
            u=stack[-1]
            opts=[v for v in NEIGHBORS[u] if v in self.g[u] and v not in seen]
            self.stats['edge_checks']+=len(NEIGHBORS[u])
            if opts:
                v=opts[0];seen.add(v);stack.append(v)
                self.step(v,actual);self.probe(actual)
            else:
                stack.pop()
                if stack:self.step(stack[-1],actual)
        assert len(self.explored)==V

    def lazy_dfs(self,target,actual):
        # Explore locally until the target is reachable in the known graph.
        # Avoid a full BFS on every newly discovered tile.
        self.probe(actual)
        if target in self.explored:return
        seen={self.pos};stack=[self.pos]
        while target not in self.explored and self.pos!=target:
            u=self.pos
            opts=[v for v in NEIGHBORS[u] if v in self.g[u] and v not in seen]
            self.stats['edge_checks']+=len(NEIGHBORS[u])
            if opts:
                # Prefer unprobed cells, then geometrical proximity.
                self.stats['frontier_scores']+=len(opts)
                v=min(opts,key=lambda v:(v in self.explored,manhattan(v,target)))
                seen.add(v);stack.append(v);self.step(v,actual);self.probe(actual)
            else:
                stack.pop()
                assert stack, 'connected maze exhausted without target'
                self.step(stack[-1],actual)

    def frontier(self,target,actual):
        self.probe(actual)
        while target not in self.explored:
            if self.method=='local_frontier':
                choices=[v for v in NEIGHBORS[self.pos] if v in self.g[self.pos] and v not in self.explored]
                self.stats['edge_checks']+=len(NEIGHBORS[self.pos])
                if choices:
                    self.stats['frontier_scores']+=len(choices)
                    dest=min(choices,key=lambda v:manhattan(v,target))
                    self.step(dest,actual);self.probe(actual)
                    continue
            start=self.pos
            parent={start:None};depth={start:0};q=deque([start])
            self.stats['bfs']+=1
            while q:
                u=q.popleft();self.stats['queue_pops']+=1
                for v in NEIGHBORS[u]:
                    self.stats['edge_checks']+=1
                    if v in self.g[u] and v not in parent:
                        parent[v]=u;depth[v]=depth[u]+1;q.append(v)
            if target in parent:
                dest=target
            else:
                candidates=[u for u in parent if u not in self.explored]
                assert candidates
                self.stats['frontier_scores']+=len(candidates)
                dest=min(candidates,key=lambda u:(depth[u]+manhattan(u,target),depth[u],u))
            path=[];u=dest
            while parent[u] is not None:path.append(u);u=parent[u]
            for v in reversed(path):
                self.step(v,actual);self.probe(actual)
                if self.pos==target:return

    def seek(self,target,actual):
        if self.method=='lazy_dfs':self.lazy_dfs(target,actual)
        elif self.method in ('frontier','local_frontier'):self.frontier(target,actual)
        if self.pos!=target:super().navigate(target,actual)
        assert self.pos==target


def run(seeds=8):
    results=[]
    for removed in [0,1,4,16]:
        rows=[]
        for seed in range(seeds):
            rng=random.Random(seed);actual=maze(rng)
            solvers=[Explorer(m) for m in ['full','lazy_dfs','frontier','local_frontier']]
            solvers[0].map_all(actual)
            walls=[(u,v) for u in range(V) for v in NEIGHBORS[u] if u<v and v not in actual[u]]
            rng.shuffle(walls)
            for round_id in range(301):
                if round_id:
                    for _ in range(min(removed,len(walls))):
                        u,v=walls.pop();actual[u].add(v);actual[v].add(u)
                target=rng.randrange(V)
                for s in solvers:
                    s.seek(target,actual)
                    if round_id==0:
                        s.stats['first_moves']=s.stats['moves']
                        s.stats['first_checks']=s.stats['edge_checks']
            for s in solvers:
                rows.append(dict(seed=seed,method=s.method,explored=len(s.explored),**s.stats))
        summary={}
        for method in ['full','lazy_dfs','frontier','local_frontier']:
            selected=[r for r in rows if r['method']==method]
            summary[method]={k:sum(r[k] for r in selected)/seeds for k in selected[0] if k not in ('method','seed')}
        results.append(dict(removed_per_relocation=removed,seeds=seeds,averages=summary,runs=rows))
    return results


if __name__=='__main__':
    print(json.dumps(run(),indent=2))
