const test = require("node:test");
const assert = require("node:assert/strict");
const Scheduler = require("../scheduler.js");

function fixtureRaw() {
  return [
    ["huis", "house", "Het huis is groot.", "The house is big.", 1],
    ["Huis", "home", "Ik ga naar huis.", "I go home.", 2], // dup of "huis" by normalized key
    ["boek", "book", "Het boek is leuk.", "The book is fun.", 1],
    ["fiets", "bike", "De fiets is kapot.", "The bike is broken.", 3],
  ];
}

test("buildQueue: caps new cards introduced within a single session, even across rebuilds", () => {
  const cards = Scheduler.buildCards(fixtureRaw()); // 3 unique cards, all "new"
  const progressById = {};
  cards.forEach((c) => (progressById[c.id] = Scheduler.freshProgress(c.id)));
  const now = Date.now();

  let queue = Scheduler.buildQueue(cards, progressById, {
    newPerSession: 2,
    newIntroducedThisSession: 0,
    now,
  });
  assert.equal(queue.length, 2);

  queue.forEach((c) => {
    progressById[c.id] = Scheduler.introduceCard(progressById[c.id]);
  });
  const newIntroducedThisSession = queue.length;

  queue = Scheduler.buildQueue(cards, progressById, {
    newPerSession: 2,
    newIntroducedThisSession,
    now,
  });
  const stillNew = queue.filter((c) => progressById[c.id].state === "new");
  assert.equal(stillNew.length, 0);
});

test("buildCards: dedupes by normalized Dutch word and merges decks", () => {
  const cards = Scheduler.buildCards(fixtureRaw());
  assert.equal(cards.length, 3);
  const huis = cards.find((c) => c.nl === "huis");
  assert.deepEqual(huis.decks, [1, 2]);
});

test("introduceCard: transitions new -> learning, first round is an options round", () => {
  const p = Scheduler.introduceCard(Scheduler.freshProgress(0));
  assert.equal(p.state, "learning");
  assert.equal(p.step, 0);
  assert.equal(Scheduler.roundMode(p), "options");
});

test("gradeCard: 'wrong' during the pre-review ladder resets to step 0 (options mode), never straight to learning", () => {
  const now = Date.now();
  let p = Scheduler.introduceCard(Scheduler.freshProgress(0));
  p = Scheduler.gradeCard(p, "right", now); // step 0 (options) -> step 1 (options)
  assert.equal(Scheduler.roundMode(p), "options");
  p = Scheduler.gradeCard(p, "right", now); // step 1 (options) -> step 2 (learning)
  assert.equal(Scheduler.roundMode(p), "learning");
  p = Scheduler.gradeCard(p, "wrong", now); // wrong in learning -> back to step 0 (options)
  assert.equal(p.state, "learning");
  assert.equal(p.step, 0);
  assert.equal(Scheduler.roundMode(p), "options");
});

test("gradeCard: 'right' walks the full ladder (options, options, learning) and graduates to review", () => {
  const now = Date.now();
  let p = Scheduler.introduceCard(Scheduler.freshProgress(0));
  for (let i = 0; i < Scheduler.LEARNING_STEPS.length; i++) {
    assert.notEqual(p.state, "review");
    p = Scheduler.gradeCard(p, "right", now);
  }
  assert.equal(p.state, "review");
  assert.equal(p.box, 0);
  assert.equal(p.dueAt, now + Scheduler.REVIEW_INTERVALS_HOURS[0] * 60 * 60 * 1000);
});

test("gradeCard in review: 'wrong' demotes all the way back to options mode, not learning mode", () => {
  const now = Date.now();
  let p = Object.assign(Scheduler.freshProgress(0), { state: "review", box: 3 });
  p = Scheduler.gradeCard(p, "wrong", now);
  assert.equal(p.state, "learning");
  assert.equal(p.step, 0);
  assert.equal(p.box, 0);
  assert.equal(Scheduler.roundMode(p), "options");
});

test("gradeCard in review: 'right' bumps box by 1, capped at the top of the ladder", () => {
  const now = Date.now();
  const top = Scheduler.REVIEW_INTERVALS_HOURS.length - 1;

  let p = Object.assign(Scheduler.freshProgress(0), { state: "review", box: 0 });
  p = Scheduler.gradeCard(p, "right", now);
  assert.equal(p.box, 1);

  p = Object.assign(Scheduler.freshProgress(0), { state: "review", box: top });
  p = Scheduler.gradeCard(p, "right", now);
  assert.equal(p.box, top);
});

test("buildOptionsChoices: includes the correct answer plus N-1 distractors, no duplicates, excludes the card itself", () => {
  const raw = [];
  for (let i = 0; i < 6; i++) raw.push([`w${i}`, `en${i}`, "s", "s", 1]);
  const cards = Scheduler.buildCards(raw);
  const card = cards[0];
  const choices = Scheduler.buildOptionsChoices(cards, card, 4);
  assert.equal(choices.length, 4);
  assert.ok(choices.includes(card.en));
  assert.equal(new Set(choices).size, 4);
});

test("buildQueue: interleaves due cards and new cards roughly 3-to-1", () => {
  const raw = [];
  for (let i = 0; i < 6; i++) raw.push([`due${i}`, `due-en${i}`, "s", "s", 1]);
  for (let i = 0; i < 2; i++) raw.push([`new${i}`, `new-en${i}`, "s", "s", 1]);
  const cards = Scheduler.buildCards(raw);
  const now = Date.now();
  const progressById = {};
  cards.forEach((c) => {
    progressById[c.id] = c.nl.startsWith("due")
      ? Object.assign(Scheduler.freshProgress(c.id), { state: "learning" })
      : Scheduler.freshProgress(c.id);
  });

  const queue = Scheduler.buildQueue(cards, progressById, {
    newPerSession: 20,
    newIntroducedThisSession: 0,
    now,
  });

  const newPositions = queue
    .map((c, i) => (progressById[c.id].state === "new" ? i : -1))
    .filter((i) => i !== -1);
  assert.deepEqual(newPositions, [3, 7]);
});

test("buildQueue: a 'learning' state card is always immediately available, with no real-time gating", () => {
  const raw = [["woord", "word", "s", "s", 1]];
  const cards = Scheduler.buildCards(raw);
  const now = Date.now();
  const progressById = {
    [cards[0].id]: Object.assign(Scheduler.freshProgress(cards[0].id), { state: "learning", step: 0 }),
  };
  const queue = Scheduler.buildQueue(cards, progressById, {
    newPerSession: 0,
    newIntroducedThisSession: 0,
    now,
  });
  assert.equal(queue.length, 1);
});

test("buildQueue: a 'review' state card only appears once its dueAt has passed", () => {
  const raw = [["woord", "word", "s", "s", 1]];
  const cards = Scheduler.buildCards(raw);
  const now = Date.now();
  const progressById = {
    [cards[0].id]: Object.assign(Scheduler.freshProgress(cards[0].id), {
      state: "review",
      box: 0,
      dueAt: now + 1000 * 60 * 60,
    }),
  };
  const queue = Scheduler.buildQueue(cards, progressById, {
    newPerSession: 0,
    newIntroducedThisSession: 0,
    now,
  });
  assert.equal(queue.length, 0);
});
