import { parseQuestions, type Question } from "./cards";
import { isDue, readSchedule, State, type Card } from "./scheduler";

export interface ReviewCard {
    path: string;
    snapshot: string;
    question: Question;
    variant: number;
    schedule: Card;
}

export function cardsFromNote(path: string, text: string, now: Date): ReviewCard[] {
    return parseQuestions(text).flatMap((question) =>
        question.variants.map((_, variant) => ({
            path,
            snapshot: text,
            question,
            variant,
            schedule: readSchedule(question.schedules[variant] || undefined, now),
        })),
    );
}

export function readyCards(cards: ReviewCard[], now: Date): ReviewCard[] {
    const due = cards.filter((card) => card.schedule.state !== State.New && isDue(card.schedule, now));
    due.sort((a, b) => a.schedule.due.getTime() - b.schedule.due.getTime());
    return [...due, ...cards.filter((card) => card.schedule.state === State.New)];
}
