import assert from "node:assert/strict";
import test from "node:test";

import {
    formatInterval,
    isDue,
    preview,
    Rating,
    readSchedule,
    State,
    writeSchedule,
} from "../src/scheduler";

const now = new Date("2026-10-15T09:00:00.000Z");
const reviewed = "!fsrs,2026-10-20T08:30:00.000Z,7,7.12567891,4.01060897,2,4,1,0,2026-10-13T08:30:00.000Z";
const learning = "!fsrs,2026-10-15T09:10:00.000Z,0,2.29815136,3.3945,1,1,0,1,2026-10-15T09:00:00.000Z";

test("reads existing FSRS state without resetting progress or losing precision", () => {
    const card = readSchedule(reviewed, now);
    assert.deepEqual(card, {
        due: new Date("2026-10-20T08:30:00.000Z"),
        scheduled_days: 7,
        stability: 7.12567891,
        difficulty: 4.01060897,
        state: State.Review,
        reps: 4,
        lapses: 1,
        learning_steps: 0,
        last_review: new Date("2026-10-13T08:30:00.000Z"),
        elapsed_days: 2,
    });
    assert.equal(writeSchedule(card), reviewed);
    assert.equal(writeSchedule(readSchedule(learning, now)), learning);
});

test("only an absent schedule creates a new card", () => {
    const card = readSchedule(undefined, now);
    assert.equal(card.state, State.New);
    assert.equal(card.reps, 0);
    assert.equal(card.due.getTime(), now.getTime());
    assert.equal(card.last_review, undefined);
    assert.equal(writeSchedule(card), "!fsrs,2026-10-15T09:00:00.000Z,0,0,0,0,0,0,0,-");
    assert.deepEqual(readSchedule(writeSchedule(card), now), card);
});

test("malformed and unsupported records are rejected instead of reset", () => {
    for (const token of [
        "",
        " ",
        "!2026-10-20,7,250",
        reviewed.replace("!fsrs", "!unknown"),
        reviewed + ",extra",
        reviewed.slice(0, reviewed.lastIndexOf(",")),
        reviewed.replace(",7,", ",NaN,"),
        reviewed.replace(",7,", ",7oops,"),
        reviewed.replace(",7,", ",-1,"),
        reviewed.replace(",7,", ",Infinity,"),
        reviewed.replace(",7,", ",,"),
        reviewed.replace(",7,", ",0x10,"),
        reviewed.replace(",2,4,1,0,", ",5,4,1,0,"),
        reviewed.replace(",2,4,1,0,", ",2,4.5,1,0,"),
        reviewed.replace(",2,4,1,0,", ",2,9007199254740992,1,0,"),
        reviewed.replace("4.01060897", "11"),
        reviewed.replace("2026-10-20T08:30:00.000Z", "2026-02-30T08:30:00.000Z"),
        reviewed.replace("2026-10-20T08:30:00.000Z", "2026-10-20"),
        reviewed.replace("2026-10-20T08:30:00.000Z", "-"),
        reviewed.replace("2026-10-13T08:30:00.000Z", "invalid"),
    ]) {
        assert.throws(() => readSchedule(token, now), /FSRS|Unsupported schedule/, token);
    }
});

test("serialization also rejects invalid scheduler output", () => {
    const card = readSchedule(reviewed, now);
    assert.throws(() => writeSchedule({ ...card, stability: NaN }), /FSRS stability/);
    assert.throws(() => writeSchedule({ ...card, due: new Date(NaN) }), /FSRS due date/);
    assert.throws(() => writeSchedule({ ...card, state: 9 as State }), /FSRS state/);
});

test("preview uses four FSRS ratings and preserves the original card", () => {
    const card = readSchedule(undefined, now);
    const before = structuredClone(card);
    const choices = preview(card, now);
    assert.deepEqual(card, before);
    for (const rating of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const) {
        assert.equal(choices[rating].log.rating, rating);
        assert.equal(choices[rating].card.reps, 1);
        assert.equal(choices[rating].card.last_review?.getTime(), now.getTime());
        assert.equal(writeSchedule(readSchedule(writeSchedule(choices[rating].card), now)), writeSchedule(choices[rating].card));
    }
    assert.equal(choices[Rating.Again].card.due.getTime() - now.getTime(), 60_000);
    assert.equal(choices[Rating.Good].card.due.getTime() - now.getTime(), 600_000);
    assert.equal(choices[Rating.Easy].card.state, State.Review);
});

test("existing review lapses use the installed ten-minute relearning step", () => {
    const choice = preview(readSchedule(reviewed, now), now)[Rating.Again];
    assert.equal(choice.card.state, State.Relearning);
    assert.equal(choice.card.due.getTime() - now.getTime(), 600_000);
    assert.equal(choice.card.lapses, 2);
    assert.equal(choice.card.reps, 5);
});

test("review cards due later today are available, but tomorrow's are not", () => {
    // Local dates deliberately exercise the user's calendar day, not UTC midnight.
    const localNow = new Date(2026, 9, 25, 10, 30);
    const card = readSchedule(reviewed, now);
    assert.equal(isDue({ ...card, due: new Date(2026, 9, 24, 23, 59) }, localNow), true);
    assert.equal(isDue({ ...card, due: new Date(2026, 9, 25, 23, 59, 59, 999) }, localNow), true);
    assert.equal(isDue({ ...card, due: new Date(2026, 9, 26, 0, 0) }, localNow), false);
});

test("learning and relearning cards wait for the exact due time", () => {
    const card = readSchedule(learning, now);
    for (const state of [State.Learning, State.Relearning]) {
        assert.equal(isDue({ ...card, state }, now), false);
        assert.equal(isDue({ ...card, state }, new Date(card.due.getTime() - 1)), false);
        assert.equal(isDue({ ...card, state }, card.due), true);
        assert.equal(isDue({ ...card, state }, new Date(card.due.getTime() + 1)), true);
    }
    assert.equal(isDue(readSchedule(undefined, now), now), true);
});

test("interval labels distinguish minutes, hours and days", () => {
    for (const [milliseconds, expected] of [
        [-1, "Now"],
        [0, "Now"],
        [30_000, "<1m"],
        [60_000, "1m"],
        [600_000, "10m"],
        [3_600_000, "1h"],
        [86_400_000, "1d"],
        [7 * 86_400_000, "7d"],
    ] as const) {
        assert.equal(formatInterval(new Date(now.getTime() + milliseconds), now), expected);
    }
});
