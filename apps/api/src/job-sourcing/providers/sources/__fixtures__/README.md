# Source fixtures

Every fixture here has a sibling `<name>.provenance.json` (shape: `phase3-common.md`, checked by
`fixture-provenance.spec.ts` and `quota-fixture-provenance.spec.ts`). Task 3.7 builds the manifest
from those files. **There are two kinds of fixture, and the provenance says which.**

## A capture

Bytes a server sent. `httpStatus` is the real status, `rawSha256` is the hash of the bytes as
received (it differs from `fileSha256`, because the committed file was trimmed by a parser), and
`trimmedBy` names the script.

## A unit example (`doc-example.json`) - NOT a capture

Written by hand from documentation, because no key is provisioned and none may be (jooble, jsearch,
theirstack, reed). It is for unit tests only and proves nothing about a provider's real response.
A manifest reader must treat all of these as the marker, in this order of strength:

1. `fetchedAt` and `termsCheckedAt` are **`1970-01-01T00:00:00.000Z`**: nothing was fetched and no
   terms were read. An epoch means "never", never a date. (The date the documentation was read is
   in `notes`.)
2. `httpStatus` is **`0`** and `rawSha256` is the SHA-256 of the empty string
   (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`): no bytes were received.
3. `trimmedBy` starts **`none: written by hand from`**.
4. `permission` is `KEY_REQUIRED`, and `notes` starts **`SENTINEL:`** and contains
   **`UNIT EXAMPLE ONLY, NOT A CAPTURE`**.

An example is replaced, not edited, when the owner's controlled authenticated smoke produces a real
response: the replacement is a capture and carries a real status and hash.
