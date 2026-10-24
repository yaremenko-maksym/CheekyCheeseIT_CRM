import json, sys
d = json.load(open(sys.argv[1]))
print({k: v for k, v in d.items() if k != 'hits'})
for h in d['hits']:
    print(h['objectID'], h['created_at'], h['author'], repr(h['title']), h.get('num_comments'), h.get('url'), h.get('_tags'))
print(sorted(d['hits'][0].keys()))
