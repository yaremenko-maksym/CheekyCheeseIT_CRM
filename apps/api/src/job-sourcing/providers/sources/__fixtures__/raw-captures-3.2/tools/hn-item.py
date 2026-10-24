import json, sys, collections
d = json.load(open(sys.argv[1]))
print({k: (v if k != 'children' else len(v)) for k, v in d.items() if k != 'text'})
ch = d['children']
print('top-level', len(ch))
keys = collections.Counter()
for c in ch:
    keys[tuple(sorted(c.keys()))] += 1
print(keys)
nulltext = [c for c in ch if c.get('text') is None]
print('null text top-level:', len(nulltext), [ (c['id'], c.get('author'), c.get('type')) for c in nulltext[:5]])
nested = sum(1 for c in ch if c['children'])
print('with replies', nested)
print('types', collections.Counter(c['type'] for c in ch))
print('author null', sum(1 for c in ch if c.get('author') is None))
lens = sorted(len(c.get('text') or '') for c in ch)
print('text len min/median/max', lens[0], lens[len(lens)//2], lens[-1])
print('parent_id==story', collections.Counter((c['parent_id'] == d['id']) for c in ch))
print(json.dumps({k: v for k, v in ch[0].items() if k != 'children'}, indent=1)[:1500])
if len(sys.argv) > 2:
    n = int(sys.argv[2])
    for c in ch[:n]:
        print('---', c['id'], c.get('author'), c['created_at'], len(c['children']))
        print(repr((c.get('text') or '')[:260]))
