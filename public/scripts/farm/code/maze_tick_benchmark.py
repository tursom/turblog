"""Tick-cost sensitivity model. API costs are documented; Python/DSL work costs are estimates.
Input includes initial exploration, 301 treasure visits, and cached map updates.
No CPython wall-clock timing or validation-oracle work is charged.
"""
import json
from pathlib import Path

PROFILES = {
    'lean': dict(edge_checks=4, queue_pops=6, frontier_scores=8,
                 path_checks=4, wall_probes=4, moves=208, bfs=8, incremental=8, shortcuts=2),
    'central': dict(edge_checks=12, queue_pops=12, frontier_scores=16,
                    path_checks=8, wall_probes=8, moves=216, bfs=16, incremental=16, shortcuts=4),
    'heavy': dict(edge_checks=24, queue_pops=24, frontier_scores=32,
                  path_checks=16, wall_probes=16, moves=232, bfs=32, incremental=32, shortcuts=8),
}
# Each treasure produces one award: 300 reuses + one final harvest.
# One maze creation, one clear, one bush plant, 301 measure calls.
# Same common work for every solver, so this cannot change the ranking.
COMMON_API_TICKS = 300*200 + 200 + 200 + 200 + 200 + 301


def score(stats, weights):
    return COMMON_API_TICKS + sum(stats[k]*w for k,w in weights.items())


def main():
    source=json.loads(Path('maze_lazy_benchmark_results.json').read_text())
    output=[]
    for row in source:
        entry={'removed_per_relocation':row['removed_per_relocation'], 'profiles':{}}
        for name,weights in PROFILES.items():
            scores={method:score(stats,weights) for method,stats in row['averages'].items()}
            winners={m:0 for m in scores}
            for seed in range(row['seeds']):
                runs=[r for r in row['runs'] if r['seed']==seed]
                winner=min(runs,key=lambda r:score(r,weights))['method']
                winners[winner]+=1
            entry['profiles'][name]={'ticks':scores,'wins':winners,'winner':min(scores,key=scores.get)}
        # Additional computation allowed per extra edge check before local-frontier
        # loses its saved movement benefit. Other overhead omitted for this diagnostic.
        full=row['averages']['full'];local=row['averages']['local_frontier']
        entry['local_vs_full_edge_break_even']=200*(full['moves']-local['moves'])/(local['edge_checks']-full['edge_checks'])
        output.append(entry)
    report={'api_costs':{'move_success':200,'can_move':1,'measure':1},
            'profiles':PROFILES,'common_api_ticks':COMMON_API_TICKS,'results':output}
    Path('maze_tick_benchmark_results.json').write_text(json.dumps(report,indent=2)+'\n')
    for row in output:
        print('walls/relocation:',row['removed_per_relocation'])
        for name,data in row['profiles'].items():
            print(name, {k:round(v/1e6,3) for k,v in data['ticks'].items()},'wins',data['wins'])
        print('edge-only break-even:',round(row['local_vs_full_edge_break_even'],3))


if __name__=='__main__':
    main()
