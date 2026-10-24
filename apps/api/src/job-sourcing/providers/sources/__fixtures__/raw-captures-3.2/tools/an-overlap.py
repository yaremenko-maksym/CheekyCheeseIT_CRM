import json, sys
a = json.load(open(sys.argv[1]))['data']
b = json.load(open(sys.argv[2]))['data']
sa = [j['slug'] for j in a]
sb = [j['slug'] for j in b]
print('dups within p1', len(sa) - len(set(sa)), 'within p2', len(sb) - len(set(sb)))
print('overlap p1/p2', len(set(sa) & set(sb)))
ia = [i for i, s in enumerate(sb) if s in set(sa)]
print('p2 indexes overlapping:', ia[:5], '...', ia[-5:] if ia else None)
pos = {s: i for i, s in enumerate(sa)}
print('p1 positions of the overlap:', [pos[sb[i]] for i in ia[:5]], [pos[sb[i]] for i in ia[-5:]])
ca = [j['created_at'] for j in a]
print('p1 sorted desc?', ca == sorted(ca, reverse=True))
cb = [j['created_at'] for j in b]
print('p2 sorted desc?', cb == sorted(cb, reverse=True))
big = sorted(((len(j['description']), j['slug']) for j in a), reverse=True)[:3]
print(big)
print(sum(len(j['description']) for j in a), sum(len(j['description']) for j in b))
