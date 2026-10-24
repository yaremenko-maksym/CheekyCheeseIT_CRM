import json, sys, collections
for f in sys.argv[1:]:
    d = json.load(open(f))
    print(f, {k: (v if k != 'data' else len(v)) for k, v in d.items()})
    keys = collections.Counter()
    types = collections.defaultdict(set)
    for j in d['data']:
        for k, v in j.items():
            keys[k] += 1
            types[k].add(type(v).__name__)
    print(dict(keys))
    print({k: sorted(v) for k, v in types.items()})
    rem = collections.Counter(j.get('remote') for j in d['data'])
    print('remote', rem)
    print('created', min(j['created_at'] for j in d['data']), max(j['created_at'] for j in d['data']))
    print('maxlens', {k: max(len(str(j.get(k))) for j in d['data']) for k in ('title', 'description', 'url', 'slug', 'company_name', 'location')})
    print(json.dumps({k: v for k, v in d['data'][0].items() if k != 'description'}, indent=1))
