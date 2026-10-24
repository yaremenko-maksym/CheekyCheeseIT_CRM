import json, sys, re, html
d = json.load(open(sys.argv[1]))
for i, c in enumerate(d['children']):
    t = c['text']
    first = re.split(r'<p>', t, maxsplit=1)[0]
    first = html.unescape(re.sub(r'<[^>]+>', '', first))
    print(i, c['id'], len(t), len(c['children']), '|', first[:150])
