"""Summarizes stale-check output files: real under-wakes vs representation artefacts of the checker itself."""
import collections, json, re, sys
def cls(line):
    kind = ':'.join(line.split(':')[2:4])
    if 'got=ERR' in line: return 'artefact: read error (path changed type / no computed for a missing path)'
    m = re.search(r'got=(.*?) want=(\S*)', line)
    if m and m.group(1) == '"undefined"' and m.group(2) == 'undefined': return 'artefact: "undefined" string vs undefined'
    if 'liveQuery' in kind and 'got=[]' in line: return 'artefact: $liveQuery [] vs undefined on a non-array'
    if kind.startswith(('subscribe', 'getBehaviorSubject', 'getObservable', 'pipe')): return 'real: rxjs subscription'
    if kind.startswith('select'): return 'real: select'
    if 'getComputed' in kind: return 'real: getComputed'
    if 'liveQuery' in kind: return 'real: liveQuery'
    return 'real: computed / effect'
for f in sys.argv[1:]:
    lines = open(f).read().splitlines()
    head = json.loads(lines[0]); c = collections.Counter(cls(l) for l in lines[1:])
    real = sum(v for k, v in c.items() if k.startswith('real'))
    print(f"{f}: checks={head['checks']} flagged={head['staleConsumers']} real={real}")
    for k, v in c.most_common(): print(f"    {v:5}  {k}")
