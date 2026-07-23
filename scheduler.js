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
  const LEARNING_STEPS = ["options", "options", "learning"];
  // Cram ladder for a 3-day deadline: 10min, 1h, 4h, 12h, 24h, 48h (box 0..5)
  // — every graduated word gets several reviews within the 3-day window,
  // instead of the slower spaced-repetition default (Resolved 2026-07-23).
  const REVIEW_INTERVALS_HOURS = [1 / 6, 1, 4, 12, 24, 48];
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

  // Build a multiple-choice option set for an "options" round: the correct
  // English answer plus `count - 1` distractors drawn from the rest of pool.
  function buildOptionsChoices(pool, card, count, rng) {
    const random = rng || Math.random;
    const others = pool.filter((c) => c.id !== card.id);
    const shuffled = others.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    const distractors = shuffled.slice(0, Math.max(0, count - 1)).map((c) => c.en);
    const choices = distractors.concat([card.en]);
    for (let i = choices.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const tmp = choices[i];
      choices[i] = choices[j];
      choices[j] = tmp;
    }
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
  function buildQueue(pool, progressById, opts) {
    const now = opts.now;
    const due = [];
    const fresh = [];
    pool.forEach((c) => {
      const p = progressById[c.id];
      if (p.state === "new") fresh.push(c);
      else if (p.state === "learning") due.push(c);
      else if (p.dueAt <= now) due.push(c);
    });
    due.sort((a, b) => progressById[a.id].dueAt - progressById[b.id].dueAt);

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
