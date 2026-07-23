/* Pure scheduling logic — no DOM, no localStorage. See CONTEXT.md for the domain glossary. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Scheduler = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Pre-review ladder: a card walks these modes in order, within a single
  // sitting — no real-time delay between steps, a card is always immediately
  // available to reappear in the queue while it's in this ladder. A wrong
  // answer at any point (including from Review) resets to step 0 — back into
  // "options" mode — never straight back into blind recall.
  // Trimmed to 1 options + 1 recall (was 2 options + 1 recall) so a new word
  // reaches blind recall — and graduates into real spaced Review — faster,
  // favoring review reps over multiple-choice exposure (Resolved 2026-07-23).
  const LEARNING_STEPS = ["options", "learning"];
  // Cram ladder for a 24-hour deadline: 5min, 15min, 1h, 3h, 8h, 16h (box 0..5)
  // — the whole ladder fits inside the 24h window so a word graduated early
  // still gets several reviews before time is up (Resolved 2026-07-23).
  const REVIEW_INTERVALS_HOURS = [1 / 12, 1 / 4, 1, 3, 8, 16];
  const MASTER_BOX = 4; // box index at which a card counts as "mastered"

  function normalizeKey(nl) {
    return nl.trim().toLowerCase();
  }

  function buildCards(raw) {
    const seen = new Map();
    raw.forEach(([nl, en, sNl, sEn, deck, breakdown]) => {
      const key = normalizeKey(nl);
      if (seen.has(key)) {
        seen.get(key).decks.add(deck);
      } else {
        seen.set(key, { nl, en, sNl, sEn, breakdown, decks: new Set([deck]) });
      }
    });
    let id = 0;
    return Array.from(seen.values()).map((c) => ({
      id: id++,
      nl: c.nl,
      en: c.en,
      sNl: c.sNl,
      sEn: c.sEn,
      breakdown: c.breakdown,
      decks: Array.from(c.decks).sort(),
    }));
  }

  function freshProgress(id) {
    return {
      id,
      state: "new", // new | learning | review
      box: 0,
      step: 0,
      dueAt: 0, // only meaningful once state === "review"
      seen: 0,
      correct: 0,
      wrong: 0,
    };
  }

  function hoursFromNow(h, now) {
    return now + h * 60 * 60 * 1000;
  }

  // What kind of round should this card be quizzed with right now?
  // 'new' | 'options' | 'learning' | 'review'
  function roundMode(progress) {
    if (progress.state === "new") return "new";
    if (progress.state === "review") return "review";
    return LEARNING_STEPS[progress.step];
  }

  function introduceCard(progress) {
    return Object.assign({}, progress, {
      state: "learning",
      step: 0,
    });
  }

  // grade: 'right' | 'wrong'. `now` is only used when a card enters or is
  // graded within Review, where real elapsed time matters.
  function gradeCard(progress, grade, now) {
    const p = Object.assign({}, progress);
    p.seen += 1;

    if (p.state === "learning") {
      if (grade === "wrong") {
        p.wrong += 1;
        p.step = 0;
      } else {
        p.correct += 1;
        p.step += 1;
        if (p.step >= LEARNING_STEPS.length) {
          p.state = "review";
          p.box = 0;
          p.dueAt = hoursFromNow(REVIEW_INTERVALS_HOURS[0], now);
        }
      }
    } else {
      // review
      if (grade === "wrong") {
        p.wrong += 1;
        p.state = "learning";
        p.step = 0;
        p.box = 0;
      } else {
        p.correct += 1;
        p.box = Math.min(p.box + 1, REVIEW_INTERVALS_HOURS.length - 1);
        p.dueAt = hoursFromNow(REVIEW_INTERVALS_HOURS[p.box], now);
      }
    }
    return p;
  }

  // In-place Fisher-Yates shuffle. Returns the same array for chaining.
  function shuffle(arr, random) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // Build a multiple-choice option set for an "options" round: the correct
  // English answer plus `count - 1` distractors drawn from the rest of pool.
  function buildOptionsChoices(pool, card, count, rng) {
    const random = rng || Math.random;
    const others = pool.filter((c) => c.id !== card.id);
    const shuffled = shuffle(others.slice(), random);
    const distractors = shuffled.slice(0, Math.max(0, count - 1)).map((c) => c.en);
    const choices = shuffle(distractors.concat([card.en]), random);
    return choices;
  }

  // pool: array of all cards.
  // progressById: map/object of cardId -> progress.
  // opts: { newPerSession, newIntroducedThisSession, now }
  //
  // A session is meant to run endlessly, cycling new/options/learning until
  // there's truly nothing left: cards in the pre-review ladder ("learning"
  // state) are always immediately ready to reappear — no real-time gating —
  // since that ladder is about repeated within-session exposure, not spaced
  // repetition. Only "review" state cards are gated by real elapsed time
  // (REVIEW_INTERVALS_HOURS), since those are meant to come back hours/days
  // later, not within the same sitting.
  function buildQueue(pool, progressById, opts, rng) {
    const random = rng || Math.random;
    const now = opts.now;
    const due = [];
    const fresh = [];
    pool.forEach((c) => {
      const p = progressById[c.id];
      if (p.state === "new") fresh.push(c);
      else if (p.state === "learning") due.push(c);
      else if (p.dueAt <= now) due.push(c);
    });
    // Shuffle first, then stable-sort by dueAt: cards with equal dueAt (all
    // "learning" state cards share dueAt=0, and ties happen in "review" too)
    // keep the shuffled order instead of always landing in a fixed id order —
    // otherwise the same options/learning/review cards line up in the same
    // sequence every session, which is as predictable as a fixed repeat gap.
    shuffle(due, random).sort((a, b) => progressById[a.id].dueAt - progressById[b.id].dueAt);
    shuffle(fresh, random);

    const remaining = Math.max(0, opts.newPerSession - opts.newIntroducedThisSession);
    const newBatch = fresh.slice(0, remaining);

    // interleave: 3 due cards per 1 new card, so learning doesn't dominate
    const merged = [];
    let di = 0, ni = 0;
    while (di < due.length || ni < newBatch.length) {
      for (let k = 0; k < 3 && di < due.length; k++) merged.push(due[di++]);
      if (ni < newBatch.length) merged.push(newBatch[ni++]);
    }
    return merged;
  }

  return {
    LEARNING_STEPS,
    REVIEW_INTERVALS_HOURS,
    MASTER_BOX,
    normalizeKey,
    buildCards,
    freshProgress,
    roundMode,
    introduceCard,
    gradeCard,
    buildOptionsChoices,
    buildQueue,
  };
});
