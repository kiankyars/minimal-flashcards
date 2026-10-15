export interface Question {
    start: number;
    end: number;
    source: string;
    context: string;
    cloze?: boolean;
    variants: Array<{ front: string; back: string }>;
    schedules: string[];
}

interface Line {
    start: number;
    end: number;
    raw: string;
    scan: string;
    code: boolean;
    comment: boolean;
}

interface Comment {
    start: number;
    end: number;
    schedule: boolean;
}

/** Mask syntax inside comments and code without changing source offsets. */
function scanText(text: string): { lines: Line[]; comments: Comment[] } {
    const lines: Line[] = [];
    const comments: Comment[] = [];
    let offset = 0;
    let commentEnd = 0;
    let fence: { character: string; length: number } | undefined;
    for (const physical of text.split(/(?<=\n)/)) {
        const raw = physical.replace(/\r?\n$/, "");
        const chars = raw.split("");
        let code = false;
        let comment = commentEnd > offset;
        const marker = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
            code = true;
            chars.fill(" ");
            if (
                marker &&
                marker[1][0] === fence.character &&
                marker[1].length >= fence.length &&
                marker[2].trim() === ""
            ) fence = undefined;
        } else if (commentEnd <= offset && marker) {
            code = true;
            fence = { character: marker[1][0], length: marker[1].length };
            chars.fill(" ");
        } else {
            let i = 0;
            while (i < raw.length) {
                if (commentEnd > offset + i) {
                    const end = Math.min(raw.length, commentEnd - offset);
                    chars.fill(" ", i, end);
                    i = end;
                } else if (raw.startsWith("<!--", i)) {
                    comment = true;
                    const start = offset + i;
                    const closing = text.indexOf("-->", start + 4);
                    commentEnd = closing === -1 ? text.length : closing + 3;
                    comments.push({ start, end: commentEnd, schedule: text.startsWith("<!--SR:", start) });
                } else if (raw[i] === "`") {
                    const run = raw.slice(i).match(/^`+/)![0];
                    let closing = raw.indexOf(run, i + run.length);
                    while (closing !== -1 && (raw[closing - 1] === "`" || raw[closing + run.length] === "`")) {
                        closing = raw.indexOf(run, closing + run.length);
                    }
                    if (closing === -1) i += run.length;
                    else {
                        code = true;
                        chars.fill(" ", i, closing + run.length);
                        i = closing + run.length;
                    }
                } else i++;
            }
        }
        lines.push({ start: offset, end: offset + raw.length, raw, scan: chars.join(""), code, comment });
        offset += physical.length;
    }
    return { lines, comments };
}

function withoutComments(text: string): string {
    const { comments } = scanText(text);
    for (const comment of comments.reverse()) text = text.slice(0, comment.start) + text.slice(comment.end);
    return text;
}

export function flashcardTags(text: string): string[] {
    const visible = scanText(text).lines.map((line) => line.scan).join("\n");
    return [...new Set([...visible.matchAll(/(?:^|[\s(])(#flashcards(?:\/[\p{L}\p{N}_-]+)*)(?=$|[\s),.;!?])/gmu)].map((match) => match[1]))];
}

export function isFlashcardNote(text: string, deck = "#flashcards"): boolean {
    return flashcardTags(text).some((tag) => tag === deck || tag.startsWith(`${deck}/`));
}

/** Parse question blocks; note eligibility is checked separately by the caller. */
export function parseQuestions(text: string): Question[] {
    const { lines, comments } = scanText(text);
    const questions: Question[] = [];
    const headings: string[] = [];
    let block: Line[] = [];

    const add = (sourceLines: Line[], variants: Question["variants"], cloze = false) => {
        const start = sourceLines[0].start;
        const end = sourceLines[sourceLines.length - 1].end;
        const schedules = comments
            .filter((comment) => comment.schedule && comment.start >= start && comment.end <= end)
            .flatMap((comment) => {
                const body = text.slice(comment.start + 7, comment.end - 3);
                if (!body) return [];
                const parts = body.startsWith("!") ? body.slice(1).split("!") : body.split("!");
                return parts.map((part) => part ? `!${part}` : "");
            });
        questions.push({ start, end, source: text.slice(start, end), context: headings.filter(Boolean).join(" > "), cloze, variants, schedules });
    };

    const flush = () => {
        while (block.length && block[0].scan.trim() === "" && !block[0].code) block.shift();
        while (block.length && block[block.length - 1].scan.trim() === "" && !block[block.length - 1].code && !block[block.length - 1].raw.includes("<!--SR:")) block.pop();
        let cursor = 0;
        while (cursor < block.length) {
            const remainder = block.slice(cursor);
            const multiline = remainder.findIndex((line) => /^\?{1,2}$/.test(line.scan.trim()));
            const inline = remainder.findIndex((line) => /(?<!:)::{1,2}(?!:)/.test(line.scan));
            if (multiline !== -1 && (inline === -1 || multiline < inline)) {
                const front = withoutComments(text.slice(remainder[0].start, remainder[multiline].start)).trim();
                const back = withoutComments(text.slice(remainder[multiline].end, remainder[remainder.length - 1].end)).trim();
                const reversed = remainder[multiline].scan.trim() === "??";
                if (front && back) add(remainder, reversed ? [{ front, back }, { front: back, back: front }] : [{ front, back }]);
                break;
            }
            if (inline !== -1) {
                const line = remainder[inline];
                const separator = line.scan.match(/(?<!:)::{1,2}(?!:)/)!;
                const split = separator.index!;
                const front = withoutComments(line.raw.slice(0, split)).trim();
                const back = withoutComments(line.raw.slice(split + separator[0].length)).trim();
                let last = cursor + inline;
                while (last + 1 < block.length && /^\s*<!--SR:[\s\S]*-->\s*$/.test(block[last + 1].raw)) last++;
                const reversed = separator[0] === ":::";
                if (front && back) add(block.slice(cursor + inline, last + 1), reversed ? [{ front, back }, { front: back, back: front }] : [{ front, back }]);
                cursor = last + 1;
                continue;
            }
            const source = text.slice(remainder[0].start, remainder[remainder.length - 1].end);
            const visible = remainder.map((line) => line.scan).join(source.includes("\r\n") ? "\r\n" : "\n");
            const clozes = [...visible.matchAll(/(?<!=)==([^\n]*?)==(?![=])/g)].filter((match) => match[1].trim());
            if (clozes.length) {
                const render = (selected: number, answer: boolean) => {
                    let rendered = source;
                    for (let i = clozes.length - 1; i >= 0; i--) {
                        const cloze = clozes[i];
                        const value = source.slice(cloze.index! + 2, cloze.index! + cloze[0].length - 2);
                        const replacement = i !== selected ? value : answer ? `==${value}==` : "[...]";
                        rendered = rendered.slice(0, cloze.index) + replacement + rendered.slice(cloze.index! + cloze[0].length);
                    }
                    return withoutComments(rendered).trim();
                };
                add(remainder, clozes.map((_, index) => ({ front: render(index, false), back: render(index, true) })), true);
            }
            break;
        }
        block = [];
    };

    for (const line of lines) {
        const heading = line.scan.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
        const tagOnly = /^\s*(?:#[\p{L}\p{N}_/-]+\s*)+$/u.test(line.scan);
        if (heading || tagOnly || (line.raw.trim() === "" && !line.code && !line.comment)) {
            flush();
            if (heading) {
                headings.length = heading[1].length;
                headings[heading[1].length - 1] = heading[2].trim();
            }
        } else block.push(line);
    }
    flush();
    return questions;
}

/** An unchanged whole-line source is required, even if earlier notes edits moved it. */
function locate(text: string, question: Question): { start: number; end: number } {
    const isWholeSource = (start: number) => {
        const end = start + question.source.length;
        return start >= 0 && question.source.length > 0 &&
            (start === 0 || text[start - 1] === "\n") &&
            (end === text.length || text[end] === "\n" || text.slice(end, end + 2) === "\r\n") &&
            text.slice(start, end) === question.source;
    };
    if (isWholeSource(question.start)) return { start: question.start, end: question.start + question.source.length };
    const matches: number[] = [];
    let start = text.indexOf(question.source);
    while (start !== -1 && question.source) {
        if (isWholeSource(start)) matches.push(start);
        start = text.indexOf(question.source, start + 1);
    }
    if (matches.length !== 1) throw new Error("The question changed or has ambiguous duplicates. Reopen review to refresh it.");
    return { start: matches[0], end: matches[0] + question.source.length };
}

export function updateSchedules(text: string, question: Question, schedules: string[]): string {
    const range = locate(text, question);
    const tokens = schedules.map((token) => {
        if (/[<>\r\n]/.test(token) || token.slice(1).includes("!")) throw new Error("Invalid schedule token.");
        return token.startsWith("!") ? token : `!${token}`;
    });
    const replacement = tokens.length ? `<!--SR:${tokens.join("")}-->` : "";
    let source = question.source;
    const comments = scanText(source).comments.filter((comment) => comment.schedule);
    if (comments.length) {
        for (let i = comments.length - 1; i >= 0; i--) {
            source = source.slice(0, comments[i].start) + (i === 0 ? replacement : "") + source.slice(comments[i].end);
        }
    } else if (replacement) source += ` ${replacement}`;
    return text.slice(0, range.start) + source + text.slice(range.end);
}

export function deleteQuestion(text: string, question: Question): string {
    const { start, end } = locate(text, question);
    const before = text.slice(0, start);
    const after = text.slice(end);
    const blankGap = /(?:\r?\n[ \t]*){2,}$/.test(before) || /^(?:[ \t]*\r?\n){2,}/.test(after);
    const left = before.replace(/(?:\r?\n[ \t]*)+$/, "");
    const right = after.replace(/^(?:[ \t]*\r?\n)+/, "");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    if (!left.trim()) return right.trim() ? right : "";
    if (!right.trim()) return left + (text.endsWith("\n") ? eol : "");
    return left + eol.repeat(blankGap ? 2 : 1) + right;
}
