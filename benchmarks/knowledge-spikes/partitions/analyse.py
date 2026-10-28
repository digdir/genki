# p50/p95/p99/max search latency per phase: python3 analyse.py phases.txt latency.txt
# A search counts in a phase when it overlaps it, so a search held up by DDL is counted in that DDL's phase.
import sys
marks = {}
for line in open(sys.argv[1]):
    t, name = line.split(); marks[name] = int(t)
rows = []
for line in open(sys.argv[2]):
    if line.startswith('#'): continue
    t, ms, ok = line.split(); rows.append((int(t), float(ms), ok == '1'))
def pct(v, p):
    v = sorted(v); return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]
phases = [('baseline', 'baseline_start', 'baseline_end'), ('load', 'load_start', 'load_end'),
          ('build', 'build_start', 'build_end'), ('build, graph in memory', 'build_start', 'build_spilled'),
          ('build, graph spilled', 'build_spilled', 'build_end'), ('attach', 'attach_start', 'attach_end'),
          ('detach and drop', 'detach_start', 'detach_end'), ('cool', 'cool_start', 'cool_end')]
if 'build_stopped' in marks: marks.setdefault('build_end', marks['build_stopped'])
base = None
print('phase | seconds | searches | per s | p50 ms | p95 ms | p99 ms | max ms | over 1 s | p95 vs baseline')
for name, a, b in phases:
    if a not in marks or b not in marks: continue
    a, b = marks[a], marks[b]
    v = [ms for t, ms, ok in rows if ok and t <= b and t + ms >= a]
    if not v: print('%s | %.0f | 0 searches' % (name, (b - a) / 1000)); continue
    p95 = pct(v, 95)
    if name == 'baseline': base = p95
    rel = '' if base is None or name == 'baseline' else '%+.0f %%' % ((p95 / base - 1) * 100)
    print('%s | %.1f | %d | %.0f | %.1f | %.1f | %.1f | %.1f | %d | %s' % (name, (b - a) / 1000, len(v), len(v) / max((b - a) / 1000, 0.001), pct(v, 50), p95, pct(v, 99), max(v), sum(1 for x in v if x > 1000), rel))
print('failed searches:', sum(1 for r in rows if not r[2]))
