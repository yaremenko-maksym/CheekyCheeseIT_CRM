#!/usr/bin/env python3 -I
"""
Trim the Next Level Jobs captures (sources-12) WITHOUT re-serialising them.

sitemap mode: an expat parser reports the byte offset of each <url>; the bytes of the kept <url>
elements are copied verbatim, and the bytes before the first <url> (the XML declaration and
<urlset>) and after the last </url> are copied verbatim too. `head -c` is never used.

page mode: the job page is kept whole, except that every e-mail address is replaced by
`redacted@example.invalid` by a regular expression. A JSON `\\u003e` / `\\u003c` escape directly
in front of an address is kept, so the escaped JSON stays valid.

usage: trim-nextleveljobs-captures.py sitemap <raw> <out> <loc>[,<loc>...]
       trim-nextleveljobs-captures.py page <raw> <out>
prints: the sha256 of the raw capture and of the output.
"""
import hashlib
import re
import sys
import xml.parsers.expat

EMAIL = re.compile(rb'(\\u003[ce])?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
URL_CLOSE = b'</url>'


def sitemap(raw: bytes, wanted: list) -> bytes:
    spans = []
    state = {'begin': None, 'in_loc': False, 'loc': []}
    parser = xml.parsers.expat.ParserCreate(namespace_separator=' ')

    def start(name, _attrs):
        local = name.split(' ')[-1]
        if local == 'url':
            state['begin'], state['loc'] = parser.CurrentByteIndex, []
        state['in_loc'] = local == 'loc'

    def end(name):
        local = name.split(' ')[-1]
        state['in_loc'] = False
        if local == 'url':
            stop = raw.index(URL_CLOSE, parser.CurrentByteIndex) + len(URL_CLOSE)
            spans.append((''.join(state['loc']).strip(), state['begin'], stop))

    def chars(data):
        if state['in_loc']:
            state['loc'].append(data)

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = chars
    parser.Parse(raw, True)
    kept = [s for s in spans if s[0] in wanted]
    missing = set(wanted) - {s[0] for s in kept}
    if missing:
        sys.exit(f'not in the capture: {sorted(missing)}')
    separator = raw[spans[0][2] : spans[1][1]]
    return raw[: spans[0][1]] + separator.join(raw[b:e] for _, b, e in kept) + raw[spans[-1][2] :]


def main() -> None:
    mode, raw_path, out_path = sys.argv[1:4]
    raw = open(raw_path, 'rb').read()
    if mode == 'sitemap':
        out = sitemap(raw, [w for w in sys.argv[4].split(',') if w])
    elif mode == 'page':
        out = EMAIL.sub(lambda m: (m.group(1) or b'') + b'redacted@example.invalid', raw)
    else:
        sys.exit(f'unknown mode {mode}')
    open(out_path, 'wb').write(out)
    print('raw ', hashlib.sha256(raw).hexdigest())
    print('file', hashlib.sha256(out).hexdigest())


if __name__ == '__main__':
    main()
