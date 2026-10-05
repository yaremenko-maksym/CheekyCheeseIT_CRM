# Notifications and employee confirmations — design

**Date:** 2026-09-01
**Status:** approved by the owner section by section, awaiting a proofread of the whole spec
**Type:** architectural (a new subsystem + an authentication change + a gate on money)

---

## 1. Task

Two related things the owner named together, but which are built differently.

**Notifications.** An employee should learn about events on their profile: a transaction was
added, its status changed, they were added to a team, added to a project, a new team
member appeared, a document is awaiting a signature. Today notifications exist, but cover
only invoices and vacancies.

**Confirmations.** Actions that affect an employee's responsibility and money do not
take effect until they agree on the platform. Two cases were named: a new project
and a share change. The owner's goal verbatim — "we remove any disagreements".

Notifications inform; confirmations change the system's state. These are different mechanics,
and they must not be mixed: a lost notification is harmless, a lost confirmation —
that is a lost share change.

## 2. What already exists (checked against the code, not the documentation)

| Component                 | State                                                                |
| ------------------------- | -------------------------------------------------------------------- |
| The `notifications` table | Exists: type, title, body, **one** link, a read marker               |
| Notification types        | Three: invoice signature, invoice signed, vacancy application        |
| Who produces them         | One service (invoices)                                               |
| The bell in the UI        | Exists, 251 lines                                                    |
| Toasts                    | `sonner` — what shadcn/ui offers as a toast. Present, used pointwise |
| Mail                      | `ResendMailerService` — via an API, not raw SMTP. Reusable           |
| Senior/drop share         | Read **through a resolver** with a cascade project → team → user     |
| Project lifecycle         | **Binary**: `archivedAt IS NULL` = active. There is no status field  |
| User address              | **One**, with a uniqueness constraint. Login — Google SSO by it      |

The conclusion that set the scope: **the transport already exists, the states are expensive.**

## 3. Owner decisions

Made in the 2026-09-01 dialogue, each — an answer to a posed question.

1. **A confirmation is a process stage**, a state of the object itself, not a separate entity.
2. **A project draft is fully invisible** to everyone except the admin and the invited employees.
3. **Rejection is possible and requires a reason.** The admin sees the reason and can propose anew.
4. **A project is confirmed by both** — the senior and the drop.
5. **A rejection by one kills the proposal entirely**; previously given consent is kept in history,
   but annulled — on a repeat proposal they confirm again.
6. **The employee configures the channels themselves.**
7. **The admin enters the personal address** at creation; the invitation with a link goes to it.

### Clarified during the spec self-check

Two things the dialogue left ambiguous; I choose explicitly so the implementer does not guess.

**A share change is confirmed by the one whose share changes.** We change the senior's percent —
the senior confirms; the drop's percent — the drop. The "both confirm" rule applies to
**project creation**, where both are affected; in a single share change the other participant is not
a party. If the owner wants otherwise — this changes only the number of rows in the approval,
not the mechanics.

**A proposal does not expire by itself.** Neither the project nor the share has a deadline after
which something happens automatically. Reason: any automatic decision here is either
"agreed by silence" (directly contradicts the goal of removing disagreements), or
"rejected by itself" (punishes being on vacation). Hanging proposals are resolved by a human: the admin
sees them in their list and can withdraw or remind.

### Assumptions I made (the owner may override)

- **Emails about confirmations and signatures cannot be turned off** — they can be muted, but not
  disabled. Otherwise the process stalls silently: the project hangs in draft because a checkbox was unchecked
  a year ago.
- **The work address stays a login method without an invitation** — it is ours, we manage it,
  and it already works. An invitation token is needed only for a personal address.

## 4. Data

### 4.1 Approvals

One table for all confirmable objects: what we confirm (the object kind + its
identifier), **who** must answer, the status (`PENDING` / `APPROVED` / `REJECTED`),
the rejection reason, the decision time, who proposed, and `supersededAt` for a repeat proposal.

**One proposal — several rows**, a row per confirmer. From this both owner requirements follow
for free: partial agreement expresses itself, and "a rejection by one kills" — that is the
killing of the remaining `PENDING` rows of the same group.

A repeat proposal does not rewrite the old rows: they are killed via `supersededAt`,
and the history shows both attempts with the rejection reason. This is exactly what removes disagreements
after the fact.

### 4.2 Project status

An explicit field: `DRAFT` / `ACTIVE` / `REJECTED`. Archived-ness **stays a separate dimension** —
mixing "not confirmed" and "finished" is forbidden, these are different facts about the project.

### 4.3 Pending share

Lies next to the current value. The resolver keeps returning the **current** value
while the approval is open; on confirmation the values swap in a single operation.

A separate table of project finance settings that mirrors the share **does not get a pending
value** — otherwise we'd introduce a second copy where even the first is already marked a mirror.

### 4.4 User addresses

A separate table: owner, address, kind (work / personal), whether confirmed, whether login is allowed.

**Why a table, not a second column.** A uniqueness constraint on a column guarantees
that work addresses do not repeat, and separately — that personal ones do not repeat. It does **not**
guarantee that one person's personal address does not coincide with another's work address. That is a direct login into
someone else's account, and two columns cannot express such a constraint in Postgres. In a separate
table the address uniqueness is a property of the construction.

## 5. Authentication

Login stays only via Google. One thing changes: user lookup by address goes through the
address table, not the column. **Three edit points**, all in a single authentication
controller file.

**An invitation instead of a verification screen.** The account-creation email carries
a one-time token. The personal address becomes a login method **only after the
link is followed and logged in through**. Before that the address exists, emails go to it,
but one cannot log in by it.

This closes the typo risk: a wrong address does not silently grant access — it manifests
as the employee not receiving the email.

**`security-review` on this PR is mandatory** by the project rule. Exactly one thing should be checked
there: can one address lead to two accounts.

## 6. Project draft: thirteen places

**The problem is not adding a status, but that nobody forgets to account for it.**

Thirteen places in seven files define a project's activity as `projects.archivedAt IS
NULL`. To assign "update the thirteen places" means getting twelve updated and one
forgotten, which surfaces in finance a month later.

> **Amendment 2026-09-02.** Here it said "twenty places in sixteen files". Twenty —
> that is all occurrences of `isNull(...archivedAt)` in the API, and they relate to **three different**
> archived-nesses: projects (13), users (5) and teams (1). User archived-ness is a
> separate dimension with a separate meaning, and substituting the project status would break
> access, not the project. The number was recomputed by execution, not from memory.

**The solution — the same one that already works on transactions:** a `visible_projects` view,
returning only confirmed and non-archived ones. Readers switch to it. Forgetting is impossible not
because they remember, but because the raw table stops being what they read.

Precedent in the repository: `non_deleted_transactions` plus a ban on raw access to the
table. The ban is extended to projects.

**The admin and confirmers** get access to the draft via an explicit narrow path — this is the
only place where a draft exists for the UI.

**A draft cannot be the subject of a transaction** — a server refusal, not a hidden button. A
button can be bypassed; money on an unconfirmed project is exactly the disagreement the task removes.

**A rejected project** stays visible to the admin with the reason, to propose anew. For
everyone else it is invisible, the same as a draft.

### 6.1 Where the draft lives in the UI (owner decision 2026-09-02)

**A filter in the existing project list, not a separate section.** A status toggle:
_Active_ (by default — i.e. exactly the current behavior) / _Awaiting confirmation_ /
_Rejected_. A draft opens with the same project card, with a badge "awaiting
confirmation: name".

A separate "Approvals" section, collecting both drafts and share-change requests, is rejected:
it gives a common queue, but at the cost of the project living in two different places depending
on status. Searching for a project by status is the worst way to search for it.

The "only via a link in a notification" option is also rejected: a read and forgotten notification
makes a stuck draft unfindable.

**A rejected one lies there until the admin removes it.** No deadline, no auto-archival. The rejection
reason stays visible — this is exactly what removes disagreements after the fact, and
a record that disappears after N days cannot do this. Auto-archival is rejected separately: it
would mix "did not agree" with "did and finished", i.e. exactly the separation for
which the status is introduced (§4.2).

## 7. Notifications

### 7.1 Action buttons are derived from the type, not stored

The record holds **the event type and the identifiers** of what it relates to. Which buttons
to show and how to name them — the client decides by type.

The alternative (storing ready-made buttons in the record) is rejected: then editing wording requires
editing data, old notifications preserve last year's phrasing, and UI texts
sprawl across database rows, where no text gate sees them.

### 7.2 Composition of types

**Inform** (configured freely): a transaction added; a transaction status
changed; added to a team; added to a project; a new team member.

**Require action** (the email is not disabled): confirm a project; confirm a new share;
sign a document.

**To the admin:** an employee confirmed; an employee rejected with a reason. Without this, a rejection
is learned only by going to look.

### 7.3 Content

A notification says **what happened and what is needed from you**; the details — behind a button.
"Your share on project X changed: 26% → 30%, please confirm" is enough; calculations and history live
on the project page.

### 7.4 Degradation

A notification lives longer than the thing it is about. The project was archived, the document was deleted —
the button must lead to an honest "the object no longer exists", not to a white screen.

## 8. UI

### 8.1 A toast and a notification are different things

A toast confirms the **user's action**: saved, sent, confirmed. A notification
reports another person's action.

Showing every incoming one as a toast means throwing "you were added to a team" into the middle
of editing a transaction. This devalues the toast where it is needed.

**Rule:** toasts — for your own actions; incoming ones — into the bell with a counter. The one exception:
an event requiring action immediately on the object open right now.

### 8.2 Fixing the popup

The list allows vertical scrolling, but **does not forbid horizontal**. Constraining the
body to two lines **does not wrap long words** — it cuts by lines, not by characters.
A single link, a wallet address or a file name without spaces goes past 320 pixels.

It does not manifest today: the three existing types have short texts. With amounts and addresses
it will creep out. **Fix before the new types**, otherwise an old bug will look like a regression from them.

### 8.3 The "what is expected of me" screen

A list of everything awaiting a response: projects, shares, documents. The bell — a feed, from
which items move down; an open obligation must not get lost under a dozen
new notifications.

### 8.4 Process gates

- **Design gate:** a new screen — Tier 1 (design before markup, acceptance by comparison with the mockup);
  the popup and toasts — Tier 2.
- **Responsive** — a hard gate on four device classes. For the popup it matters: 320
  pixels — the width where horizontal scrolling appears first.

## 9. Work order

| #   | What                                                | Why here                                        |
| --- | --------------------------------------------------- | ----------------------------------------------- |
| 1   | Fixing the popup                                    | Depends on nothing; needed before new types     |
| 2   | Address table + login + invitation                  | Foundation: without it there is nowhere to send |
| 3   | Approvals table                                     | Foundation of confirmations                     |
| 4   | Project draft: status, view, guard                  | The riskiest: thirteen places                   |
| 5   | Pending share                                       | One point in the resolver                       |
| 6   | Notification types and their producers              | Requires 2–5 to exist                           |
| 7   | Mail, settings, the "what is expected of me" screen | The top layer                                   |

## 10. Risks

**Thirteen places (item 4).** The volume at which "update everywhere" loses one place. Hence a change
of the read source plus a guard, not an edit by list. **If the guard does not come out without false
positives — do not add it**, but say so and propose otherwise: a noisy guard breeds
a habit of bypassing, and we have been through this.

**Authentication (item 2).** A hole invisible from the diff: one address leading to two
accounts.

**Notification producers (item 6) are quietly large.** Each — an edit in another's service:
transactions, teams, projects, documents. Five modules, and in each one must not break the
existing.

**Money notifications are a disclosure.** The text "share 26% → 30%" goes to a **personal**
mailbox, outside our perimeter. The volume of what gets into the email should be kept minimal:
the email calls into the CRM, the details — there.

## 11. Email texts

Approved by the owner 2026-09-01. The email **contains no amounts and no percentages** — it names the gist
of the request and leads into the CRM. Incidentally this reduces the cost of a leak: the email goes to a personal
mailbox, outside our perimeter, and by itself discloses no finances.

### Subjects

A unified prefix **"Request for …"** for everything that requires an answer. It signals that this is a
proposal, not an accomplished fact, even before the email is opened. Incidentally the emails
line up in the mailbox as a recognizable row, and the email client learns from them faster than from
heterogeneous subjects.

- `Запрос на добавление проекта «{название}»`
- `Запрос на смену процента по проекту «{название}»`
- `Запрос на подпись: {тип документа} за {период}`
- `Доступ к CRM CheekyCheeseIT` — the invitation, this is not a request

### Rules the texts obey

- **One button per email.** "Open" and "Reject" side by side would mean a rejection can be
  given without entering, — but we need a trace in the system with a reason.
- **Not a single thank-you or polite frame.** A transactional email that thanks
  reads like a mailing and lands in "Promotions" together with it.
- **In the share-change email the second line removes the fright:** the previous share is in effect, the new one
  takes effect only after consent. Without this a person, seeing the subject, decides that something
  has already been changed for them.
- **In the invitation the last line is a protection, not politeness:** "if the email arrived by
  mistake, do not follow the link". It turns an address typo from a silent hole into a
  situation clear to the recipient.
- The texts pass `copy-reviewer` — a project rule explicitly says that self-checking on
  one's own text does not work.

## 12. Deliverability (measured 2026-09-01)

| Record                       | State               |
| ---------------------------- | ------------------- |
| DKIM on the root domain      | present             |
| SPF on the sending subdomain | present             |
| **SPF on the root domain**   | **absent**          |
| **DMARC**                    | **absent entirely** |

The configured sender address is on the **root**, and SPF — on the subdomain. The signature partially
compensates, but the alignment is fragile.

**Both records live in DNS, not in code** — the implementer can prepare, only the owner can
apply.

### About the "Important" marker in Gmail

**The sender cannot set it.** Importance is computed by the mail service for each
recipient separately, by their own behavior. Priority headers are not accounted for for this marker;
an email that sends them does not become important, but some filters treat this
as a sign of a mailing — i.e. the attempt may worsen deliverability.

**Achievable instead:** landing in the primary tab, not promotions (no
promotional layout); one constant sender that the mail learns on; splitting the
streams — action-required separately from informational; a one-time request to the team to add the
address to contacts.

### Layout

Email clients are not browsers: our tokens and modern layout do not work there. Emails
are laid out with tables and inline styles. This is a property of the environment, not a choice.
