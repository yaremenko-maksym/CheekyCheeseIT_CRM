import json, sys, re, html
d = json.load(open(sys.argv[1]))
h = d['hits'][0]
t = h['story_text']
print(html.unescape(re.sub(r'<[^>]+>', '\n', t)))
