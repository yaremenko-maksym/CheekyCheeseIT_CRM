import json, sys
for f in sys.argv[1:]:
    d = json.load(open(f))
    print(f, len(d['data']), d['links'].get('next'), d['meta'].get('from'), d['meta'].get('to'), d['meta'].get('per_page'))
