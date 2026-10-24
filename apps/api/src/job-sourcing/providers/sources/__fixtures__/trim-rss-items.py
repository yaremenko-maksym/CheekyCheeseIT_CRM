#!/usr/bin/env python3 -I
"""
Trim an RSS 2.0 capture to a chosen set of <item> elements WITHOUT re-serialising it.

This is the `trimmedBy` of every `*.trimmed.xml` fixture under this directory. It is parser-based on
purpose: an expat parser reports the byte offset of each `<item>` and `</item>`, the bytes of the kept
items are copied verbatim, and everything before the first item (the channel header) and after the
last item is copied verbatim too. Nothing is escaped, re-indented or re-prefixed, so what the fixture
carries is what the feed sent. `head -c` is never used (it cuts through an element).

usage: trim-rss-items.py <raw capture> <output> <guid>[,<guid>...]
       trim-rss-items.py <raw capture> <output> @truncate:<n>
       trim-rss-items.py <raw capture> <output> @truncate-at-channel-close
prints: the sha256 of the raw capture and of the output, and the guids kept in document order.

`@truncate:<n>` derives a MALFORMED-envelope fixture from a real capture: the bytes up to and
including the end of the n-th <item> (found by the parser), with the closing </channel></rss> left
off, so the document ends mid-structure the way an interrupted transfer would.
`@truncate-at-channel-close` does the same for a feed with no items: the bytes up to the start of
the closing </channel> tag, as reported by the parser.
"""
import hashlib
import sys
import xml.parsers.expat


def main(raw_path: str, out_path: str, wanted_csv: str) -> None:
    raw = open(raw_path, 'rb').read()
    wanted = [g for g in wanted_csv.split(',') if g]

    spans = []  # (start, end, guid)
    state = {'depth': 0, 'start': 0, 'guid': None, 'in_guid': False}

    parser = xml.parsers.expat.ParserCreate()

    def start(name, _attrs):
        state['depth'] += 1
        if name == 'item' and state['depth'] == 3:
            state['start'] = parser.CurrentByteIndex
            state['guid'] = ''
        elif name == 'guid' and state['depth'] == 4:
            state['in_guid'] = True

    def end(name):
        if name == 'guid' and state['in_guid']:
            state['in_guid'] = False
        if name == 'channel' and state['depth'] == 2:
            state['channel_close'] = parser.CurrentByteIndex
        if name == 'item' and state['depth'] == 3:
            close = raw.index(b'>', parser.CurrentByteIndex) + 1
            spans.append((state['start'], close, state['guid'].strip()))
        state['depth'] -= 1

    def text(data):
        if state['in_guid']:
            state['guid'] += data

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    parser.Parse(raw, True)

    if wanted_csv == '@truncate-at-channel-close':
        out = raw[: state['channel_close']]
        open(out_path, 'wb').write(out)
        print('rawSha256 ', hashlib.sha256(raw).hexdigest())
        print('fileSha256', hashlib.sha256(out).hexdigest())
        print('items in capture', len(spans), '| bytes kept', len(out), 'of', len(raw))
        return

    if wanted_csv.startswith('@truncate:'):
        count = int(wanted_csv.split(':', 1)[1])
        out = raw[: spans[count - 1][1]]
        open(out_path, 'wb').write(out)
        print('rawSha256 ', hashlib.sha256(raw).hexdigest())
        print('fileSha256', hashlib.sha256(out).hexdigest())
        print('items in capture', len(spans), '| bytes kept', len(out), 'of', len(raw))
        return

    by_guid = {guid: (s, e) for s, e, guid in spans}
    missing = [g for g in wanted if g not in by_guid]
    if missing:
        sys.exit('guid(s) not in the capture: %s' % missing)

    kept = sorted((by_guid[g] for g in wanted), key=lambda se: se[0])
    out = raw[: spans[0][0]]
    previous_end = None
    for start_at, end_at in kept:
        if previous_end is not None:
            # The whitespace that sat in front of this item in the capture.
            gap_from = max(
                (e for s, e, _ in spans if e <= start_at), default=start_at
            )
            out += raw[gap_from:start_at]
        out += raw[start_at:end_at]
        previous_end = end_at
    out += raw[spans[-1][1] :]

    open(out_path, 'wb').write(out)
    print('rawSha256 ', hashlib.sha256(raw).hexdigest())
    print('fileSha256', hashlib.sha256(out).hexdigest())
    print('items in capture', len(spans), '| kept', len(kept))
    for start_at, end_at in kept:
        print(' ', [g for s, e, g in spans if s == start_at][0])


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
