import re, html, sys
t = open(sys.argv[1], encoding='utf8').read()
t = re.sub(r'<script.*?</script>|<style.*?</style>', '', t, flags=re.S)
t = html.unescape(re.sub(r'<[^>]+>', ' ', t))
t = re.sub(r'\s+', ' ', t)
pat = sys.argv[2] if len(sys.argv) > 2 else None
if pat:
    for m in re.finditer(pat, t):
        print('..', t[max(0, m.start() - 200):m.end() + 400])
        print()
else:
    print(len(t))
    print(t[:6000])
