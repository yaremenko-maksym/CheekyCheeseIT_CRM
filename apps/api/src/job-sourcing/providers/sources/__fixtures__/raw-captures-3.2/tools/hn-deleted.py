import json, sys
def walk(n, depth, out):
    for c in n.get('children', []):
        if c.get('text') is None or c.get('author') is None or c.get('type') != 'comment':
            out.append((depth, c['id'], c.get('author'), c.get('type'), repr(c.get('text'))[:60]))
        walk(c, depth + 1, out)
for f in sys.argv[1:]:
    d = json.load(open(f))
    out = []
    walk(d, 1, out)
    print(f, 'null/odd entries:', len(out), out[:6])
