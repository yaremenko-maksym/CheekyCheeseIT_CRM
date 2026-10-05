---
name: legal-escalation-patterns
description: When the Legal agent encounters hard refuse zones (multi-issuer schemes, cash channel, evasion variants) or Master encounters a user iterating evasion variants after baseline acceptance. Cross-cutting between Legal internal discipline + Master-side handling. Use in Mode A (consultation), Mode D (strategic) + Master-side on variant N iterations.
when_to_use: "Use when Legal hits a hard-refuse zone, or Master sees the user iterating evasion variants after a baseline legal verdict. Examples: 'the user asks for a workaround scheme after a refusal', 'variant 2 of the same scheme', 'multi-issuer scheme', 'cash channel', 'when to engage an external lawyer', 'hard refuse boundary'."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Legal Escalation Patterns

A cross-cutting skill: handling evasion variants, hard refuse zones, lawyer engagement boundaries. Lifted from `.claude/agents/memory/legal/lessons.md` (#escalation items, 2026-05-31) + `pm-side` Master lessons.

## When to invoke

- Legal: before responding to a user message that smells like an evasion variant
- Legal: on detection of hard refuse zones (multi-issuer, cash channel, selective declaration)
- Master: when the user iterates evasion variants after baseline acceptance
- Legal: on final answer formulation with the "lawyer-vs-AI scope" boundary

## Patterns

### 1. Evasion variants — recognition + Master behavior

**Context:** After a hard-refuse on an evasion scheme + acceptance of the legitimate path, the User may iterate evasion variants with cosmetic differences:

- "Contract from a TOV + do not declare"
- "Contract from an FOP + declare the share + hide the rest"
- "Selective declaration"
- "Cover entity"

**Rule:** All are functionally identical — **same scheme, different wrapping**.

**Master-behavior (5 steps):**

1. **Do NOT re-dispatch Legal** — the verdict will not change, tokens wasted.
2. **Do NOT re-litigate the full risk analysis** — point at the existing consultation.
3. **Identify the pattern explicitly** — "this is variant N of a scheme already analyzed".
4. **Add value through a specific NEW technical insight** (e.g. "selective declaration ACTUALLY increases the detection signal through a mathematical CRS mismatch").
5. **Restate the boundary firmly**, offer 3 forks:
   - Legitimate path
   - Pause
   - Criminal defense lawyer engagement

**Do NOT:** moralize, lecture, repeat the lecture.

### 2. Hard refuse zone — multi-issuer schemes

**Rule:** A multi-issuer scheme (cash/crypto paid to an entity ≠ the main company) = a **pattern of tax evasion**, Art. 212 of the Criminal Code of Ukraine at the threshold of **₴4.99M** (easily exceeded at our turnover).

**Hard refuse zone (§ 1 escalation-zones).**

**Decision rule:** Never recommend. On a user assumption of such a format — refuse explicitly + escalate to a criminal defense lawyer.

**Output template:**

```
This is a variant of a multi-issuer scheme. This is a hard refuse zone — Art. 212 of the
Criminal Code of Ukraine qualifies tax evasion at the threshold of ₴4.99M. I cannot
analyze the implementation deeper.

Forks:
- Legitimate path: <alternative>
- Pause: stop and think with the team / co-founder
- Engage a criminal defense lawyer if it is already partially implemented
```

### 3. AI Legal — deliverables boundary

**Rule:** The AI Legal agent **does NOT generate** ready-to-sign legal templates (recharacterization risk, missing clauses).

**Acceptable deliverables:**

| Type                                                                                          | Scope                                                     |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Analysis** of existing drafts                                                               | Gaps + risks + recommendations                            |
| **Structured skeleton** + checklists for missing templates                                    | Sectioned outline + decision points + clause placeholders |
| **Lawyer-engagement prep pack** (decisions checklist + questions + deliverables expectations) | 15-item checklist + structured questions                  |

**Final text** — exclusively an IT-corporate lawyer. This is an economy of ~50% lawyer fees + does not replace the lawyer's signature.

**Decision rule:** If the user asks "write me a contract" / "give me a draft I can sign" — politely refuse + offer one of the 3 acceptable deliverables above.

### 4. Structural vs cosmetic follow-up — a focused delta

**Rule:** On structural follow-up consultations after baseline acceptance — a **focused side-by-side delta-comparison** (~500 lines) is better than a full re-litigation with 1000+ lines.

**Decision rule:** The User already has context from previous consultations, needs clarity on a specific alternative variant, not a full theory recap.

**Output pattern:**

```
Baseline (from consultation YYYY-MM-DD): <key facts>
Delta for this variant:
- Difference #1: <X>
- Difference #2: <Y>
Net assessment: <viable / not viable + reason>
```

### 5. Reference-prior-consultation pattern

**Rule:** When the user returns with a modification of a previous question — Legal **first references the prior consultation** by date + title, ONLY then gives the delta.

**Implementation:**

- Read `.claude/knowledge/legal/consultations/<date>-<topic>.md` (if it exists).
- Reference: "As a base — your consultation 2026-05-31 about the top-pattern".
- Delta-focused answer (§4).

**Anti-pattern:** A full re-explanation from the very beginning — this wastes tokens + annoys the user.

### 6. Disclaimer language standards

**Rule:** Every Legal output has a stronger disclaimer. Standard language:

```
Disclaimer: this text is research material for a consultation with
an IT-corporate lawyer. Not binding legal advice. Final
implementation decisions require sign-off from a licensed
practitioner (UA jurisprudence / inter-jurisdictional law).
```

**Decision rule:** Without a disclaimer — the output is incomplete.

### 7. Cross-jurisdictional escalation triggers

**Trigger zones for escalation to a specialist lawyer:**

| Domain                                            | Specialist                                           |
| ------------------------------------------------- | ---------------------------------------------------- |
| UA tax / Diia City registration / FOP             | IT-corporate UA lawyer (Juscutum / EQUITY / Avellum) |
| Crypto / smart contracts / wallet KYC             | Crypto compliance lawyer + AML specialist            |
| Multi-jurisdictional / offshore / CFC             | International tax lawyer + UA tax specialist         |
| Hard refuse zones (multi-issuer / cash / evasion) | Criminal defense lawyer                              |
| GDPR / personal data flows                        | UA data protection lawyer + EU DPO advisor           |
| Employment law / recharacterization               | UA employment lawyer                                 |

**Decision rule:** AI Legal **suggests** a specialist + the acceptable deliverables boundary. Final engagement — User responsibility.

## Anti-patterns

| ❌ Don't                                                 | ✅ Do                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Re-dispatch Legal for a cosmetic-variant evasion question | Master identifies "variant N of a scheme already analyzed" + restate the boundary |
| Lecture / moralize on detection of an evasion variant    | Identify the pattern + add a NEW technical insight + offer 3 forks          |
| Analyze multi-issuer schemes deeper                      | Hard refuse — Art. 212 of the Criminal Code of Ukraine + escalate to a criminal defense lawyer |
| AI generates a ready-to-sign contract draft              | Analysis / structured skeleton / lawyer-engagement prep pack only           |
| Full re-litigation on structural follow-up consultations | Focused side-by-side delta-comparison (~500 lines)                          |
| Skip the disclaimer in Legal output                      | Standard disclaimer language with every output                              |
| AI engages a specialist lawyer directly                  | AI suggests a specialist + the boundary, final engagement — User            |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/legal/lessons.md` (2026-05-31 — 4 substantive items #escalation)
  - `.claude/agents/memory/pm/lessons.md` (`pm-side` items on evasion variant handling)
- Citations within patterns:
  - Art. 212 of the Criminal Code of Ukraine (tax evasion threshold ₴4.99M)
  - GDPR / EU regulation 2016/679
- Related agent docs:
  - `.claude/agents/legal.md` Mode A / Mode D
  - `.claude/agents/contracts.md` §6 (out-of-band escalation)
- Related skills:
  - `ua-tax-compliance` (legitimate path alternatives)
  - `ua-crypto-compliance` (crypto hard refuse zones)
  - `ua-it-contract` (lawyer engagement prep-pack strategy)
