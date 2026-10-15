import assert from "node:assert/strict";
import { test } from "node:test";

import { deleteQuestion, isFlashcardNote, parseQuestions, updateSchedules } from "../src/cards";

const first = "!fsrs,2030-01-01,2,1.2,4,2,3,0,0,2029-12-30";
const second = "!fsrs,2030-01-03,4,2.4,5,2,2,0,0,2029-12-30";

test("note eligibility respects tag boundaries and ignores comments and code", () => {
    assert.equal(isFlashcardNote("#flashcards/chips/memory\n"), true);
    assert.equal(isFlashcardNote("Some prose (#flashcards)."), true);
    assert.equal(isFlashcardNote("#flashcards-other\n"), false);
    assert.equal(isFlashcardNote("<!-- #flashcards -->\n`#flashcards`\n```\n#flashcards\n```"), false);
});

test("basic questions retain exact CRLF source offsets and heading context", () => {
    const text = `#flashcards/test\r\n# Topic\r\n## Detail\r\n\r\n- Question::Answer <!--SR:${first}-->\r\n`;
    const [question] = parseQuestions(text);
    assert.equal(question.source, `- Question::Answer <!--SR:${first}-->`);
    assert.equal(text.slice(question.start, question.end), question.source);
    assert.equal(question.context, "Topic > Detail");
    assert.deepEqual(question.variants, [{ front: "- Question", back: "Answer" }]);
    assert.deepEqual(question.schedules, [first]);
});

test("multiline questions preserve math, images, inline code and embedded fenced code", () => {
    const text = "#flashcards\n\nHow does `$x$` work?\n?\n$$x^2$$\n![figure](figures/example.png)\n```text\nnot::a card\n?\n==not a cloze==\n```\n\nNext::Answer\n";
    const questions = parseQuestions(text);
    assert.equal(questions.length, 2);
    assert.equal(questions[0].variants[0].front, "How does `$x$` work?");
    assert.match(questions[0].variants[0].back, /\$\$x\^2\$\$/);
    assert.match(questions[0].variants[0].back, /not::a card/);
    for (const question of questions) assert.equal(text.slice(question.start, question.end), question.source);
});

test("fake syntax in fenced code, inline code, and HTML comments creates no cards", () => {
    const text = "#flashcards\n\n~~~markdown\nFake::Card\n==fake==\n~~~\n\n`Fake::Card`\n\n<!--\nFake::Card\n?\n==fake==\n-->\n\nReal::Answer <!-- ignored::syntax -->\n";
    const questions = parseQuestions(text);
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0].variants, [{ front: "Real", back: "Answer" }]);
});

test("cloze variants hide only the selected cloze and share all schedule slots", () => {
    const text = `#flashcards\n\nA ==first== and a ==second==.\n<!--SR:${first}${second}-->\n`;
    const [question] = parseQuestions(text);
    assert.deepEqual(question.schedules, [first, second]);
    assert.deepEqual(question.variants, [
        { front: "A [...] and a second.", back: "A ==first== and a second." },
        { front: "A first and a [...].", back: "A first and a ==second==." },
    ]);
    const updated = updateSchedules(text, question, [second, first]);
    assert.equal(updated, text.replace(`${first}${second}`, `${second}${first}`));
    assert.deepEqual(parseQuestions(updated)[0].schedules, [second, first]);
});

test("a schedule-only next line belongs to its question; legacy slots and empty slots survive", () => {
    const text = "#flashcards\n\nQ::A\n<!--SR:!2028-03-01,4,250-->\nNext::B\n";
    const questions = parseQuestions(text);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions[0].schedules, ["!2028-03-01,4,250"]);
    const cloze = "#flashcards\n\n==One== and ==Two==\n";
    const updated = updateSchedules(cloze, parseQuestions(cloze)[0], ["", second]);
    assert.deepEqual(parseQuestions(updated)[0].schedules, ["", second]);
    assert.equal(parseQuestions(updated)[0].variants.length, 2);
});

test("adding a schedule preserves neighboring content and the original line endings", () => {
    const text = "#flashcards\r\n\r\nQ::A\r\n\r\nUnrelated paragraph.\r\n";
    const updated = updateSchedules(text, parseQuestions(text)[0], [first]);
    assert.equal(updated, text.replace("Q::A", `Q::A <!--SR:${first}-->`));
});

test("reversed inline and multiline questions create two ordered sibling cards", () => {
    const text = `#flashcards\n\nOne:::Two <!--SR:${first}${second}-->\n\nFront\n??\nBack\n`;
    const questions = parseQuestions(text);
    assert.deepEqual(questions[0].variants, [{ front: "One", back: "Two" }, { front: "Two", back: "One" }]);
    assert.deepEqual(questions[1].variants, [{ front: "Front", back: "Back" }, { front: "Back", back: "Front" }]);
    assert.deepEqual(questions[0].schedules, [first, second]);
    assert.equal(deleteQuestion(text, questions[0]), "#flashcards\n\nFront\n??\nBack\n");
    const updated = updateSchedules(text, questions[0], [second, first]);
    assert.deepEqual(parseQuestions(updated)[0].schedules, [second, first]);
});

test("deleting removes the whole cloze question and all siblings, with one blank line at the join", () => {
    const text = `#flashcards\n\n# Topic\n\n\n==One== and ==Two==\n<!--SR:${first}${second}-->\n\n\nOther::Answer\n`;
    const remaining = deleteQuestion(text, parseQuestions(text)[0]);
    assert.equal(remaining, "#flashcards\n\n# Topic\n\nOther::Answer\n");
    assert.equal(parseQuestions(remaining).length, 1);
});

test("deletion keeps adjacent list cards adjacent and handles first, last and only questions", () => {
    const text = "- One::A\n- Two::B\n- Three::C\n";
    assert.equal(deleteQuestion(text, parseQuestions(text)[1]), "- One::A\n- Three::C\n");
    assert.equal(deleteQuestion("\n\nOne::A\n\nOther prose\n", parseQuestions("\n\nOne::A\n\nOther prose\n")[0]), "Other prose\n");
    assert.equal(deleteQuestion("# Topic\n\nOne::A\n\n", parseQuestions("# Topic\n\nOne::A\n\n")[0]), "# Topic\n");
    assert.equal(deleteQuestion("\nOne::A\n\n", parseQuestions("\nOne::A\n\n")[0]), "");
});

test("multiline deletion preserves surrounding prose/headings and CRLF", () => {
    const text = "# Topic\r\n\r\nQuestion\r\n?\r\nAnswer\r\n\r\n## Next\r\nProse\r\n";
    assert.equal(deleteQuestion(text, parseQuestions(text)[0]), "# Topic\r\n\r\n## Next\r\nProse\r\n");
});

test("mutations find a uniquely moved question, but reject edited or ambiguous source", () => {
    const text = "#flashcards\n\nQ::A\n";
    const question = parseQuestions(text)[0];
    const moved = "A new introduction.\n\n" + text;
    assert.equal(updateSchedules(moved, question, [first]), moved.replace("Q::A", `Q::A <!--SR:${first}-->`));
    assert.throws(() => deleteQuestion(text.replace("Q::A", "Q::AB"), question), /changed|ambiguous/);
    assert.throws(() => updateSchedules(text.replace("Q::A", "New::A"), question, [first]), /changed|ambiguous/);
    assert.throws(() => deleteQuestion("An introduction.\n\nQ::A\n\nQ::A\n", question), /changed|ambiguous/);
});

test("original offsets distinguish identical questions without deleting their neighbor", () => {
    const text = "Q::A\nQ::A\n";
    const questions = parseQuestions(text);
    assert.equal(deleteQuestion(text, questions[1]), "Q::A\n");
    assert.equal(updateSchedules(text, questions[1], [first]), `Q::A\nQ::A <!--SR:${first}-->\n`);
});

test("headings reset deeper context and are never part of a deleted question", () => {
    const text = "# Root\n## Detail\nOne::A\n# Next\nTwo::B\n";
    const questions = parseQuestions(text);
    assert.deepEqual(questions.map((question) => question.context), ["Root > Detail", "Next"]);
    assert.equal(deleteQuestion(text, questions[0]), "# Root\n## Detail\n# Next\nTwo::B\n");
});
