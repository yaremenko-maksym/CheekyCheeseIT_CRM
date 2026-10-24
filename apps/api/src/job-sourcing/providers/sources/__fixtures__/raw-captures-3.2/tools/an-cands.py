import json, sys
d = json.load(open(sys.argv[1]))['data']
for i, j in enumerate(d):
    if len(j['description']) < 1800 or j['remote']:
        print(i, j['slug'][:60], '|', j['company_name'][:25], '|', j['title'][:40], '| remote', j['remote'], '| loc', repr(j['location'][:20]), '| jt', j['job_types'], '| tags', len(j['tags']), '| len', len(j['description']), '|', j['created_at'])
