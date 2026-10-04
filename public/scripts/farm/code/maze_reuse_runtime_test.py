"""Execute the actual game module with modeled APIs, not a reimplemented solver."""
from pathlib import Path
import random

class Names:
    def __getattr__(self,key):return key


def scenario(seed, removed, budget=1000000, treasures=303, size=32, rebuild_interval=64):
    rng=random.Random(seed);n=size
    pos=0;edges=set();gold=0;materials=budget;target=0;live=False
    relocations=0;finished=[];clears=0;moves=0;walls=[]
    def adjacent(a,d):
        x,y=a%n,a//n;dx,dy=[(0,1),(1,0),(0,-1),(-1,0)][d];x+=dx;y+=dy
        return x+y*n if 0<=x<n and 0<=y<n else -1
    def edge(a,b):return tuple(sorted((a,b)))
    def clear():
        nonlocal pos,clears
        assert not live, 'discarded live treasure'
        pos=0;clears+=1
    def use(item,amount):
        nonlocal materials,live,relocations,gold,target,walls
        assert materials>=amount
        materials-=amount
        if not live:
            edges.clear();seen={0};stack=[0]
            while stack:
                a=stack[-1];options=[adjacent(a,d) for d in range(4) if adjacent(a,d)>=0 and adjacent(a,d) not in seen]
                if not options:stack.pop();continue
                b=rng.choice(options);edges.add(edge(a,b));seen.add(b);stack.append(b)
            walls=[edge(a,b) for a in range(n*n) for d in range(4) if (b:=adjacent(a,d))>a and edge(a,b) not in edges]
            rng.shuffle(walls);live=True;relocations=0
        else:
            assert pos==target and relocations<300
            gold+=n*n;relocations+=1
            for _ in range(min(removed,len(walls))):edges.add(walls.pop())
        target=rng.randrange(n*n)
        return True
    def can(d):
        b=adjacent(pos,d);return b>=0 and edge(pos,b) in edges
    def move(d):
        nonlocal pos,moves
        assert can(d),'invalid movement'
        pos=adjacent(pos,d);moves+=1
        assert moves<2000000,'nontermination'
        return True
    def harvest():
        nonlocal gold,live
        assert live and pos==target,'harvested hedge'
        gold+=n*n;live=False;finished.append(relocations);return True
    env=dict(North=0,East=1,South=2,West=3,Items=Names(),Entities=Names(),Unlocks=Names(),
             get_pos_x=lambda:pos%n,get_pos_y=lambda:pos//n,get_world_size=lambda:n,
             num_unlocked=lambda _:1,num_items=lambda item:gold if item=='Gold' else materials,
             clear=clear,plant=lambda _:True,use_item=use,can_move=can,move=move,harvest=harvest,
             measure=lambda:(target%n,target//n),get_entity_type=lambda:('Treasure' if pos==target else 'Hedge') if live else None)
    exec(compile(Path('maze_reuse.py').read_text(),'maze_reuse.py','exec'),env)
    env['TREE_REBUILD_INTERVAL']=rebuild_interval
    rebuild=env['rebuild_tree'];rebuild_calls=[]
    def checked_rebuild(graph,root):
        before=(pos,moves,clears,materials,gold,relocations)
        assert rebuild_interval>0 and relocations>0 and relocations%rebuild_interval==0
        tree=rebuild(graph,root)
        parent,depth=tree
        assert parent[root]==-1 and depth[root]==0
        for node,p in parent.items():
            if p!=-1:
                assert node in graph[p] and depth[node]==depth[p]+1
        for u in parent:
            for v in graph[u]:
                if v>=0:assert v in depth and abs(depth[u]-depth[v])<=1
        assert before==(pos,moves,clears,materials,gold,relocations)
        rebuild_calls.append((clears,relocations,env['graph_revision']))
        return tree
    env['rebuild_tree']=checked_rebuild
    result=env['run_maze_batch'](treasures*n*n)
    assert len(rebuild_calls)==len({(c,r) for c,r,v in rebuild_calls})
    for c in range(1,clears+1):
        versions=[v for maze,r,v in rebuild_calls if maze==c]
        assert all(a<b for a,b in zip(versions,versions[1:]))
    if rebuild_interval==0:assert not rebuild_calls
    if rebuild_interval>0 and treasures==303 and budget>=treasures*n:assert rebuild_calls
    assert not live
    if budget>=treasures*n:
        assert result and gold>=treasures*n*n
        if treasures==303:assert finished==[300,1],finished
    else:assert not result
    return moves,clears,finished

if __name__=='__main__':
    for removed in [0,1,4,16]:
        for seed in range(3):
            moves,clears,finished=scenario(seed,removed)
            print(removed,seed,moves,clears,finished)
    assert scenario(0,4,budget=0)[1]==0
    scenario(0,4,budget=32*3)
    scenario(0,4,treasures=1)
    scenario(0,4,rebuild_interval=0)
    scenario(0,4,rebuild_interval=32)
    print('Passed: production code, tree rebuild invariants/timing, disabled/32/64 intervals, cap/final harvest, insufficient materials, early target')
