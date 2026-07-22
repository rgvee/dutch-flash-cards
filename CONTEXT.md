# Dutch Flashcards — Domain Glossary

## Card
A single vocabulary entry: Dutch word (`nl`), English translation (`en`), an example sentence in each language, and the set of source decks (Mock 1–4) it appeared in. Cards are deduplicated by normalized Dutch word — one Card exists per unique word even if it appeared in multiple source decks.

## Progress
Per-card learning state, persisted across sessions, namespaced per Profile. Fields: `state` (New | Learning | Review), `box` (Review only — position on the review ladder), `step` (Learning only — position on the pre-review ladder), `dueAt` (Review only — the card is eligible for its next quiz once the current time passes this; meaningless while `state` is `learning`, see "Pre-review ladder has no real-time gating").

## New
A card never yet introduced. Shown once as a passive exposure screen — Dutch + English + example sentence together, no quiz, no grading. A single "Next" button advances (renamed from an earlier "Got it — quiz me on this," which implied a real choice was being made when there wasn't one).

## Round mode
What kind of quiz a Learning-state card is shown right now, derived from its `step` on the pre-review ladder: `options` (multiple choice) or `learning` (blind recall). A Review-state card is always in `review` mode.

## Pre-review ladder
The sequence of rounds a card walks through between New and Review, in order: **Options, Options, Learning**. Rationale: the user found it unfair/uncomfortable to be blind-recall tested right after a single exposure, so two rounds of gentler multiple-choice recognition come first, and blind recall is only asked once the word has already been seen and correctly recognized twice. (Decided 2026-07-22.)

**No real-time gating.** Unlike Review, the pre-review ladder has no timers — a card mid-ladder is always immediately eligible to reappear in the queue, so a session can cycle endlessly through New/Options/Learning in one sitting. (Resolved 2026-07-22: an earlier version attached real minute-scale delays — 5/15/60 min — between ladder steps, which caused the queue to run dry and the session to falsely report "complete" within a couple of minutes. Only Review, which is meant to resurface hours/days later, should ever be gated by real elapsed time.)

## Options mode
A quiz round on the pre-review ladder: the Dutch word is shown with 4 English choices (the correct answer plus 3 distractors drawn from other cards). Tapping a choice immediately grades the card Right/Wrong — there is no separate "show answer" step.

## Learning mode
A quiz round on the pre-review ladder (its final step): the Dutch word is shown alone; the user recalls the English meaning from memory, then taps "Show answer" to reveal it and self-grades Right/Wrong.

## Grading
Binary: **Right** or **Wrong** (previously three options — Again/Good/Easy — simplified to reduce cognitive load per user request). Wrong at any point on the pre-review ladder, or in Review, resets the card to step 0 of the pre-review ladder — i.e. back to **Options mode**, never straight back into blind recall. Right advances one step; once the ladder (Options, Options, Learning) is exhausted, the card graduates to Review.

## Review
A card that has graduated out of the pre-review ladder. Quizzed on an hour/day-scale ladder, indexed by `box`, always in blind-recall style like Learning mode. Wrong demotes the card back to the start of the pre-review ladder (Options mode, `step` 0). Right advances the box by 1, capped at the top of the ladder.

## Mastered
A Review-state card whose `box` has reached the mastery threshold — survived several successful reviews in a row. Used only for the home-screen stat count; has no effect on scheduling.

## Session
The span from tapping "Study" on the Home screen until returning Home. A session is endless by design — it keeps cycling New/Options/Learning cards for as long as the user keeps studying, only reporting "complete" once every introduced card has genuinely graduated to Review with nothing yet due (see "Pre-review ladder has no real-time gating"). A session tracks how many New cards have been introduced *during that session*, separate from the user's target cap — this distinction exists specifically so the cap can be enforced (see "New words per session" below).

## New words per session
A user setting capping how many New cards may be introduced within a single Session. **Decision:** this must be enforced via a session-scoped counter, not by filtering on card state — a card stops being "New" the instant it's introduced, so state alone can't tell you "already counted against this session's cap" once the queue rebuilds. (Resolved 2026-07-22 after the counter was found to be missing — the cap was silently unenforced across queue rebuilds within one sitting.)

## Queue / queue rebuild
The ordered list of cards to work through in the current Session: Due cards interleaved with New cards, 3-to-1, respecting the remaining New-card budget for the session. Rebuilt automatically whenever it empties mid-session (e.g. more cards became Due) — this is why the New-card cap must live at the session level, not be recomputed per rebuild. This rebuild-on-empty behavior is also what makes a session endless: any card still on the pre-review ladder is unconditionally Due, so it's naturally picked back up on the next rebuild without any manual requeuing logic.

**Minimum requeue gap.** Because a pre-review-ladder card is unconditionally due, it can land right back at the front of a rebuild the instant its previous round is answered — showing e.g. its Options and Learning rounds for the same word back-to-back with nothing in between. **Decision:** whenever a card is introduced or graded and remains on the pre-review ladder, it's spliced back into the live queue at least `REQUEUE_GAP` (5) cards ahead, rather than left to whatever position a full rebuild happens to give it. This is enforced in `app.js` (`requeueCard`), not in the pure `scheduler.js` functions, since it's about live queue *ordering* within a session, not the underlying due/not-due state. (Resolved 2026-07-22 after the user noticed Options and Learning rounds appearing consecutively for the same word.)

## Due
Either (a) a Learning-state (pre-review ladder) card, unconditionally — no real-time gating, always eligible to reappear — or (b) a Review-state card whose `dueAt` has passed. Eligible to appear in the queue.

## Deck filter (removed)
Previously a user setting restricting the active card pool to a single source deck (Mock 1–4) or "All decks." **Decision:** removed from the UI — user doesn't care which of the four source decks a word came from, only that all of them get learned. `decks` remains on each Card as metadata (dedup provenance), the full pool is always active. (Resolved 2026-07-22.)

## Profile
One of two fixed, no-login user identities — "Ram" or "Rudrakshi" — each with independently persisted Progress and Settings (namespaced localStorage keys). **Decision:** the app always shows a "Who's studying?" picker on load rather than remembering the last-used profile on the device, per explicit user choice, since the two users share the same device/browser. (Resolved 2026-07-22.)

## Active-pool redesign (considered, rejected)
Considered restructuring around a fixed-size "active pool" (e.g. exactly 20 words in flight at once, a 21st only entering once one graduates) instead of the current per-session New-card cap. **Decision:** keep the current session-cap model rather than switching to a fixed pool — user confirmed the existing flow (exposure → interleaved pre-review ladder → Review) is the right shape once the session-cap bug is fixed. (Resolved 2026-07-22.)
