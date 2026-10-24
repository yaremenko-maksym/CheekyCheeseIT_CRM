import json, sys
d = json.load(open(sys.argv[1]))
r = d['item'][0]['response'][0]
b = json.loads(r['body'])
print(json.dumps({k: v for k, v in b.items() if k != 'data'}, indent=1))
print(json.dumps(b['data'][0], indent=1)[:1500])
print(d['item'][0]['request'].get('description'))
print(d['item'][0]['request']['url'].get('query'))
