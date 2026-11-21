#!/usr/bin/env python3 -I
"""
Trim the Dice and No Fluff Jobs captures (sources-14).

The raw pages are 0.26 to 0.92 MB each, almost all of it markup the adapters never read, so a
fixture keeps ONLY the elements an adapter reads, inside a minimal HTML shell:

dice-listing: the Next.js flight payload (`self.__next_f.push([1, "..."])` scripts) is joined and
  split into rows. Kept: the first 3 rows verbatim (non-JSON rows the parser must skip), the row
  holding the search `jobList` with its `data` cut to the first <n> items, and the row holding
  the "Similar Jobs" `jobList` cut to 1 item. The two jobList rows are RE-SERIALISED (json.dumps,
  key order kept). The rows are emitted as two push scripts split INSIDE the search row, so the
  fixture pins that a row may span two scripts.
nfj-listing: the `serverApp-state` JSON is parsed; kept are `USER_COUNTRY` and the one container
  with `postings` + `totalPages`, its `postings` cut to the first <n>. Re-serialised (json.dumps).
detail: the `<link rel="canonical">` element and every `application/ld+json` script element are
  copied byte for byte; nothing else of the page is kept.

Every mode replaces e-mail addresses by `redacted@example.invalid`.

usage: trim-dice-nofluff-captures.py dice-listing|nfj-listing <raw> <out> <n>
       trim-dice-nofluff-captures.py detail <raw> <out>
prints: the sha256 of the raw capture and of the output.
"""
import hashlib
import json
import re
import sys

EMAIL = re.compile(rb'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
PUSH = re.compile(rb'<script>self\.__next_f\.push\((\[.*?\])\)</script>', re.S)
ROW = re.compile(r'^([0-9a-z]+):(\[.*)$', re.S)
STATE = re.compile(rb'<script id="serverApp-state" type="application/json">(.*?)</script>', re.S)
CANONICAL = re.compile(rb'<link[^>]*rel="canonical"[^>]*>')
LD = re.compile(rb'<script[^>]*type="application/ld\+json"[^>]*>.*?</script>', re.S)


def shell(head: bytes, body: bytes) -> bytes:
    return b'<!DOCTYPE html><html><head>' + head + b'</head><body>' + body + b'</body></html>\n'


def push(text: str) -> bytes:
    return b'<script>self.__next_f.push(' + json.dumps([1, text]).encode() + b')</script>'


def dice_listing(raw: bytes, n: int) -> bytes:
    payload = ''.join(json.loads(m.group(1))[1] for m in PUSH.finditer(raw))
    rows = payload.split('\n')
    search = similar = None
    for row in rows:
        m = ROW.match(row)
        if not m or '"jobList"' not in row:
            continue
        value = json.loads(m.group(2))
        props = value[3]
        if isinstance(props, dict) and 'jobList' in props and 'totalPages' in props:
            props['jobList']['data'] = props['jobList']['data'][:n]
            search = f'{m.group(1)}:{json.dumps(value)}'
        elif similar is None:
            # The similar-jobs list sits deep in a layout tree: cut every jobList in the row.
            def cut(o):
                if isinstance(o, dict):
                    if 'jobList' in o:
                        o['jobList']['data'] = o['jobList']['data'][:1]
                    for v in o.values():
                        cut(v)
                elif isinstance(o, list):
                    for v in o:
                        cut(v)
            cut(value)
            similar = f'{m.group(1)}:{json.dumps(value)}'
    if search is None or similar is None:
        sys.exit('no search or similar-jobs jobList row')
    text = '\n'.join(rows[:3] + [search, similar]) + '\n'
    split = text.index(search) + len(search) // 2
    return shell(b'', push(text[:split]) + push(text[split:]))


def nfj_listing(raw: bytes, n: int) -> bytes:
    state = json.loads(STATE.search(raw).group(1))
    kept = {'USER_COUNTRY': state['USER_COUNTRY']}
    for key, value in state.items():
        if isinstance(value, dict) and 'postings' in value and 'totalPages' in value:
            value['postings'] = value['postings'][:n]
            kept[key] = value
    if len(kept) != 2:
        sys.exit('expected exactly one postings container')
    script = b'<script id="serverApp-state" type="application/json">'
    return shell(b'', script + json.dumps(kept, ensure_ascii=False).encode() + b'</script>')


def detail(raw: bytes) -> bytes:
    canonical = CANONICAL.search(raw)
    if canonical is None:
        sys.exit('no canonical link')
    return shell(canonical.group(0) + b''.join(m.group(0) for m in LD.finditer(raw)), b'')


def main() -> None:
    mode, raw_path, out_path = sys.argv[1:4]
    raw = open(raw_path, 'rb').read()
    if mode == 'dice-listing':
        out = dice_listing(raw, int(sys.argv[4]))
    elif mode == 'nfj-listing':
        out = nfj_listing(raw, int(sys.argv[4]))
    elif mode == 'detail':
        out = detail(raw)
    else:
        sys.exit(f'unknown mode {mode}')
    out = EMAIL.sub(b'redacted@example.invalid', out)
    open(out_path, 'wb').write(out)
    print('raw ', hashlib.sha256(raw).hexdigest())
    print('file', hashlib.sha256(out).hexdigest())


if __name__ == '__main__':
    main()
