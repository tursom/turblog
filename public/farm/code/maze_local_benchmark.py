"""Budgeted local replanning vs tree-route one-edge shortcuts.
Simulation only; cost profiles are estimates, not measured game ticks.
"""
from collections import deque
from pathlib import Path
import json
import random
from maze_memory_benchmark import MemoryExplorer, scores
from maze_lazy_benchmark import maze, N, V, NEIGHBORS, manhattan


class LocalExplorer(MemoryExplorer):
    def __init__(self,budget,search_limit=None):
        super().__init__('tree_chords')
        self.budget=budget
        self.search_limit=search_limit
        self.stats.update(local_calls=0,local_success=0,local_expanded=0,
                          local_candidates=0,trigger_checks=0,local_peak=0)

    def local_path(self,order,cursor):
        self.stats['local_calls']+=1
        self.stats['bfs']+=1
        root=self.pos
        q=deque([root]);parents={root:None};depth={root:0}
        best=None;best_gain=0;expanded=0
        while q and expanded<self.budget:
            u=q.popleft();expanded+=1;self.stats['queue_pops']+=1
            for v in NEIGHBORS[u]:
                self.stats['edge_checks']+=1
                if v not in self.g[u] or v in parents:continue
                parents[v]=u;depth[v]=depth[u]+1;q.append(v)
                self.stats['cache_writes']+=2
                if v in order and order[v]>cursor:
                    self.stats['local_candidates']+=1
                    gain=order[v]-cursor-depth[v]
                    if gain>best_gain:
                        best_gain=gain;best=v
        self.stats['local_expanded']+=expanded
        self.stats['local_peak']=max(self.stats['local_peak'],len(parents))
        assert expanded<=self.budget
        if best is None:return None
        route=[];v=best
        while parents[v] is not None:
            route.append(v);v=parents[v];self.stats['tree_steps']+=1
        route.reverse()
        assert len(route)<order[best]-cursor
        self.stats['local_success']+=1
        return route,order[best]

    def seek(self,target,actual):
        self.lazy_dfs(target,actual)
        if self.pos==target:return
        short=self.shortcut(target)
        if short is not None:
            self.stats['shortcuts']+=1;self.execute(short,actual)
            assert self.pos==target;return
        path=self.tree_route(target)
        order={node:i for i,node in enumerate(path)}
        self.stats['cache_writes']+=len(order)
        self.stats['cache_entries_peak']=max(self.stats['cache_entries_peak'],len(order))
        cursor=-1;since_search=8;searches=0
        while cursor<len(path)-1:
            added=self.probe(actual)
            chosen=cursor+1
            for v in NEIGHBORS[self.pos]:
                self.stats['edge_checks']+=1
                if v in self.g[self.pos] and v in order and order[v]>chosen:
                    chosen=order[v]
            # Always take the cheap known one-edge shortcut first.
            local=None
            if self.budget and (self.search_limit is None or searches<self.search_limit):
                self.stats['trigger_checks']+=1
                remaining=len(path)-1-cursor
                if chosen==cursor+1 and remaining>manhattan(self.pos,target)+4:
                    if (added or since_search>=8) and (self.search_limit is None or searches<self.search_limit):
                        local=self.local_path(order,cursor)
                        searches+=1
                        since_search=0
            if local is not None:
                segment,end=local
                for v in segment:
                    self.probe(actual);self.step(v,actual);since_search+=1
                assert end>cursor
                cursor=end
            else:
                self.step(path[chosen],actual);cursor=chosen;since_search+=1
        self.probe(actual)
        assert self.pos==target


def tick_scores(stats):
    values=scores(stats)
    # Local candidate scoring and trigger geometry are not just one comparison.
    for profile,scale in [('lean',1),('central',2),('heavy',4)]:
        values[profile]+=scale*(8*stats['local_candidates']+12*stats['trigger_checks'])
    return values


def run(seeds=8,search_limit=None):
    results=[]
    for removed in [0,1,4,16]:
        runs=[]
        for seed in range(seeds):
            rng=random.Random(seed);actual=maze(rng)
            solvers={b:LocalExplorer(b,search_limit) for b in [0,16,32,64]}
            walls=[(u,v) for u in range(V) for v in NEIGHBORS[u] if u<v and v not in actual[u]]
            rng.shuffle(walls)
            for round_id in range(301):
                if round_id:
                    for _ in range(min(removed,len(walls))):
                        u,v=walls.pop();actual[u].add(v);actual[v].add(u)
                target=rng.randrange(V)
                for solver in solvers.values():
                    solver.seek(target,actual)
                    assert solver.pos==target
            for budget,solver in solvers.items():
                runs.append(dict(seed=seed,budget=budget,stats=solver.stats,ticks=tick_scores(solver.stats)))
        averages={}
        for budget in solvers:
            group=[r for r in runs if r['budget']==budget]
            averages[budget]={k:sum(r['stats'][k] for r in group)/seeds for k in group[0]['stats']}
            averages[budget]['ticks']={p:sum(r['ticks'][p] for r in group)/seeds for p in ['lean','central','heavy']}
            averages[budget]['wins_vs_baseline']={p:sum(r['ticks'][p]<next(b['ticks'][p] for b in runs if b['seed']==r['seed'] and b['budget']==0) for r in group) for p in ['lean','central','heavy']}
        results.append(dict(removed=removed,seeds=seeds,search_limit=search_limit,averages=averages,runs=runs))
    return results


if __name__=='__main__':
    results=run()
    Path('maze_local_benchmark_results.json').write_text(json.dumps(results,indent=2)+'\n')
    for row in results:
        print('walls/relocation',row['removed'])
        for budget,s in row['averages'].items():
            print(budget,'moves',round(s['moves']), 'calls',round(s['local_calls']),
                  'success',round(s['local_success']), 'ticks(M)',{p:round(v/1e6,3) for p,v in s['ticks'].items()},
                  'wins',s['wins_vs_baseline'])
