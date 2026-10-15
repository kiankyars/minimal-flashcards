import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cardsFromNote, readyCards } from "../src/queue";
import { readSchedule, State, writeSchedule } from "../src/scheduler";

test("due cards precede new cards; future reviews and learning steps wait", () => {
    const now = new Date("2026-10-15T08:00:00.000Z");
    const cards = cardsFromNote("test.md", "#flashcards\n\nNew::Answer\n\nDue::Answer\n\nLater::Answer\n\nLearning::Answer", now);
    cards[1].schedule = { ...cards[1].schedule, state: State.Review, due: new Date(now.getTime() - 86400000) };
    cards[2].schedule = { ...cards[2].schedule, state: State.Review, due: new Date(now.getTime() + 86400000) };
    cards[3].schedule = { ...cards[3].schedule, state: State.Learning, due: new Date(now.getTime() + 60000) };
    assert.deepEqual(readyCards(cards, now).map((card) => card.question.variants[0].front), ["Due", "New"]);
    assert.equal(readyCards(cards, new Date(now.getTime() + 60000)).length, 3);
});

test("explicit New sibling records remain new across reopening", () => {
    const now = new Date("2026-10-15T08:00:00.000Z");
    const token = writeSchedule(readSchedule(undefined, now));
    const cards = cardsFromNote("test.md", `#flashcards\n\nA ==red== and ==blue==. <!--SR:${token}${token}-->`, now);
    assert.equal(cards.length, 2);
    assert.ok(cards.every((card) => card.schedule.state === State.New));
});

test("a blank legacy sibling slot remains new without shifting later schedules", () => {
    const now = new Date("2026-10-15T08:00:00.000Z");
    const token = writeSchedule({ ...readSchedule(undefined, now), state: State.Review, reps: 2, stability: 5, difficulty: 4, last_review: now });
    const cards = cardsFromNote("test.md", `#flashcards\n\nA ==red== and ==blue==. <!--SR:!${token}-->`, now);
    assert.equal(cards[0].schedule.state, State.New);
    assert.equal(cards[1].schedule.state, State.Review);
});
