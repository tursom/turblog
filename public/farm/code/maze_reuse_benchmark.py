"""Deterministic model benchmark; not a game script.
DFS-generated 32x32 mazes, uniformly sampled treasures and random wall removals.
Counts exclude initial mapping (identical), planting, resource use and interpreter ticks.
"""
from collections import deque
import random
import json

N = 32
V = N*N

def neighbors(u):
    x,y=u%N,u//N
    return [v for ok,v in [(y<N-1,u+N),(x<N-1,u+1),(y>0,u-N),(x>0,u-1)] if ok]

NEIGHBORS=[neighbors(u) for u in range(V)]

def maze(rng):
    g=[set() for _ in range(V)]
    seen={0}; stack=[0]
    while stack:
        u=stack[-1]; opts=[v for v in NEIGHBORS[u] if v not in seen]
        if not opts: stack.pop(); continue
        v=rng.choice(opts);g[u].add(v);g[v].add(u);seen.add(v);stack.append(v)
    return g

class Solver:
    def __init__(self, graph, optimized):
        self.g=[set(row) for row in graph]
        self.optimized=optimized
        self.pos=0
        self.stats=dict(moves=0, edge_checks=0, queue_pops=0, bfs=0,
                        incremental=0, shortcuts=0, wall_probes=0, path_checks=0)
    def bfs(self, target):
        self.stats['bfs']+=1
        d=[V+1]*V;d[target]=0;q=deque([target])
        while q:
            u=q.popleft();self.stats['queue_pops']+=1
            for v in self.g[u]:
                self.stats['edge_checks']+=1
                if d[v]==V+1:d[v]=d[u]+1;q.append(v)
        return d
    def probe(self, actual):
        added=[];u=self.pos
        for v in NEIGHBORS[u]:
            if v not in self.g[u]:
                self.stats['wall_probes']+=1
                if v in actual[u]:
                    self.g[u].add(v);self.g[v].add(u);added.append((u,v))
        return added
    def relax(self,d,edges):
        self.stats['incremental']+=1
        q=deque();queued=set()
        def improve(u,v):
            self.stats['edge_checks']+=1
            if d[u]+1<d[v]:
                d[v]=d[u]+1
                if v not in queued: queued.add(v);q.append(v)
        for u,v in edges:improve(u,v);improve(v,u)
        while q:
            u=q.popleft();queued.remove(u);self.stats['queue_pops']+=1
            for v in self.g[u]:improve(u,v)
    def shortcut(self,target):
        for axes in [(1,N),(N,1)]:
            u=self.pos;path=[];valid=True
            for stride in axes:
                while (u%N != target%N if stride==1 else u//N != target//N):
                    delta=(target%N-u%N) if stride==1 else (target//N-u//N)
                    v=u+(stride if delta>0 else -stride)
                    self.stats['path_checks']+=1
                    if v not in self.g[u]:valid=False;break
                    path.append(v);u=v
                if not valid:break
            if valid:return path
        return None
    def navigate(self,target,actual):
        if self.optimized:
            path=self.shortcut(target)
            if path is not None:
                self.stats['shortcuts']+=1
                for v in path:
                    self.probe(actual)
                    assert v in actual[self.pos]
                    self.pos=v;self.stats['moves']+=1
                self.probe(actual);return
        d=self.bfs(target)
        while self.pos!=target:
            added=self.probe(actual)
            if added:
                if self.optimized:self.relax(d,added)
                else:d=self.bfs(target)
                # Validate incremental distances exactly, without charging the oracle.
                if self.optimized:
                    oracle=[V+1]*V;oracle[target]=0;q=deque([target])
                    while q:
                        u=q.popleft()
                        for v in self.g[u]:
                            if oracle[v]==V+1:oracle[v]=oracle[u]+1;q.append(v)
                    assert d==oracle
            v=next(v for v in NEIGHBORS[self.pos] if v in self.g[self.pos] and d[v]==d[self.pos]-1)
            assert v in actual[self.pos]
            self.pos=v;self.stats['moves']+=1
        self.probe(actual)

def run(seeds=5):
    result=[]
    for removals in [0,1,4,16]:
        totals=[{},{}]
        for seed in range(seeds):
            rng=random.Random(seed);actual=maze(rng)
            solvers=[Solver(actual,False),Solver(actual,True)]
            walls=[(u,v) for u in range(V) for v in NEIGHBORS[u] if u<v and v not in actual[u]]
            rng.shuffle(walls)
            for round_id in range(301):
                if round_id:
                    for _ in range(min(removals,len(walls))):
                        u,v=walls.pop();actual[u].add(v);actual[v].add(u)
                target=rng.randrange(V)
                for solver in solvers:
                    solver.navigate(target,actual)
                    assert solver.pos==target
            for i,s in enumerate(solvers):
                for k,v in s.stats.items():totals[i][k]=totals[i].get(k,0)+v
        result.append(dict(walls_removed_per_relocation=removals,seeds=seeds,
                           baseline=totals[0],optimized=totals[1]))
    return result

if __name__=='__main__':
    print(json.dumps(run(),indent=2))
