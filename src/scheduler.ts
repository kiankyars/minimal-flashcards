import { createEmptyCard, fsrs, Rating, State, type Card, type RecordLog } from "ts-fsrs";

export { Rating, State };
export type { Card, RecordLog, ReviewLog, Grade } from "ts-fsrs";

export const REMNOTE_RATINGS = [
    { rating: Rating.Again, label: "Forgot" },
    { rating: Rating.Hard, label: "Partially recalled" },
    { rating: Rating.Good, label: "Recalled with effort" },
    { rating: Rating.Easy, label: "Easily recalled" },
] as const;

const DAY = 24 * 60 * 60 * 1000;

// Match the installed Spaced Repetition settings. Its maximum interval overrides
// ts-fsrs's 36500-day default; its learning steps and weights use library defaults.
// ts-fsrs 5.4.2 implements FSRS-6, not RemNote's entire review-queue behavior.
const scheduler = fsrs({
    request_retention: 0.9,
    maximum_interval: 36525,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: ["1m", "10m"],
    relearning_steps: ["10m"],
});

function validDate(value: Date, field: string): Date {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new Error(`Invalid FSRS ${field}: expected a valid date.`);
    }
    return value;
}

function readDate(value: string, field: string): Date {
    // Existing notes use Date.toISOString(), including milliseconds and UTC.
    // Reject ambiguous local dates and dates that JavaScript silently normalizes.
    const date = new Date(value);
    if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString() !== value
    ) {
        throw new Error(`Invalid FSRS ${field}: expected an ISO UTC timestamp.`);
    }
    return date;
}

function validNumber(value: number, field: string, integer = false): number {
    if (
        !Number.isFinite(value) ||
        value < 0 ||
        (integer && !Number.isSafeInteger(value))
    ) {
        throw new Error(`Invalid FSRS ${field}: expected a nonnegative ${integer ? "integer" : "number"}.`);
    }
    return value;
}

function readNumber(value: string, field: string, integer = false): number {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
        throw new Error(`Invalid FSRS ${field}: expected a number.`);
    }
    return validNumber(Number(value), field, integer);
}

function validateCard(card: Card): void {
    validDate(card.due, "due date");
    if (card.last_review !== undefined) validDate(card.last_review, "last review");
    validNumber(card.scheduled_days, "interval");
    validNumber(card.stability, "stability");
    validNumber(card.difficulty, "difficulty");
    if (card.difficulty > 10) throw new Error("Invalid FSRS difficulty: must be at most 10.");
    if (![State.New, State.Learning, State.Review, State.Relearning].includes(card.state)) {
        throw new Error("Invalid FSRS state.");
    }
    validNumber(card.reps, "repetitions", true);
    validNumber(card.lapses, "lapses", true);
    validNumber(card.learning_steps, "learning steps", true);
}

/**
 * Read one token from an existing <!--SR:...--> comment without changing its
 * schedule. Source format: Spaced Repetition's RepItemScheduleInfoFsrs serializer
 * (!fsrs,due,interval,stability,difficulty,state,reps,lapses,learningSteps,lastReview).
 * These tokens contain current state, not review history or scheduler parameters.
 * Only an absent token denotes a new card; unsupported records must be surfaced.
 */
export function readSchedule(token: string | undefined, now: Date): Card {
    validDate(now, "current time");
    if (token === undefined) return createEmptyCard(now);

    const fields = token.split(",");
    if (fields.length !== 10 || fields[0] !== "!fsrs") {
        throw new Error("Unsupported schedule: expected one !fsrs token with 10 fields.");
    }

    const lastReview = fields[9] === "-" ? undefined : readDate(fields[9], "last review");
    const card: Card = {
        due: readDate(fields[1], "due date"),
        scheduled_days: readNumber(fields[2], "interval"),
        stability: readNumber(fields[3], "stability"),
        difficulty: readNumber(fields[4], "difficulty"),
        state: readNumber(fields[5], "state", true),
        reps: readNumber(fields[6], "repetitions", true),
        lapses: readNumber(fields[7], "lapses", true),
        learning_steps: readNumber(fields[8], "learning steps", true),
        last_review: lastReview,
        // This deprecated library field is derived rather than stored in SR tokens.
        elapsed_days: lastReview ? Math.max(0, Math.floor((now.getTime() - lastReview.getTime()) / DAY)) : 0,
    };
    validateCard(card);
    return card;
}

/** Serialize only current FSRS state in the existing inline SR token format. */
export function writeSchedule(card: Card): string {
    validateCard(card);
    return [
        "!fsrs",
        card.due.toISOString(),
        card.scheduled_days,
        card.stability,
        card.difficulty,
        card.state,
        card.reps,
        card.lapses,
        card.learning_steps,
        card.last_review?.toISOString() ?? "-",
    ].join(",");
}

/** Calculate the four choices without persisting a rating or review log. */
export function preview(card: Card, now: Date): RecordLog {
    validateCard(card);
    validDate(now, "current time");
    return scheduler.repeat(card, now);
}

/** Review cards are due all day; learning/relearning cards wait until their time. */
export function isDue(card: Card, now: Date): boolean {
    validDate(card.due, "due date");
    validDate(now, "current time");
    if (card.state === State.Review) {
        const tomorrow = new Date(now);
        tomorrow.setHours(24, 0, 0, 0);
        return card.due.getTime() < tomorrow.getTime();
    }
    return card.due.getTime() <= now.getTime();
}

export function formatInterval(due: Date, now: Date): string {
    const remaining = validDate(due, "due date").getTime() - validDate(now, "current time").getTime();
    if (remaining <= 0) return "Now";
    if (remaining < 60_000) return "<1m";
    if (remaining < 3_600_000) return `${Math.ceil(remaining / 60_000)}m`;
    if (remaining < DAY) return `${Math.ceil(remaining / 3_600_000)}h`;
    return `${Math.round(remaining / DAY)}d`;
}
