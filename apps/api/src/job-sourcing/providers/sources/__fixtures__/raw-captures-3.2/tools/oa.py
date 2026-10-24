import json, sys
d = json.load(open(sys.argv[1]))
print(json.dumps(d['info'], indent=1))
print('servers', d.get('servers'))
for p, v in d['paths'].items():
    print('PATH', p, list(v.keys()))
    for m, op in v.items():
        if not isinstance(op, dict):
            continue
        print('  ', m, op.get('operationId'), op.get('deprecated'), '|', (op.get('summary') or '')[:100])
        print('     desc:', (op.get('description') or '')[:1500])
        for prm in op.get('parameters', []):
            print('     param', json.dumps(prm)[:400])
print('SCHEMAS', list(d.get('components', {}).get('schemas', {}).keys()))
