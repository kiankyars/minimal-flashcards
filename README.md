# Minimal Flashcards

A small Obsidian extension for Kian. Mac only.

Run **Minimal Flashcards: Review all cards** or click its ribbon icon. The first card opens immediately: due cards first, then new cards, with no daily cap or deck chooser.

To review one deck, use **Minimal Flashcards: Review a specific deck** in the command palette (**Cmd+P**). Pick a deck by its existing `#flashcards/...` tag. Parent decks include their subdecks; choosing `chips` includes `chips/process`, for example.

- **Space** reveals the answer.
- **1–4** rate it: Forgot, Partially recalled, Recalled with effort, Easily recalled. Each button shows its next interval.
- **Open note** opens the source at the question.
- **Delete** immediately removes the entire source question and its sibling cards. It removes the scheduling comment and closes the blank gap without merging neighboring paragraphs.
- **Esc** or the single native close button closes review.

## Cards and scheduling

Use the existing `#flashcards` tag or a nested tag such as `#flashcards/chips`. Supported forms are `question::answer`, reversed `question:::answer`, multiline `?` / `??`, and `==highlight clozes==`. Native Obsidian rendering handles Markdown, images, code, and math.

The extension uses FSRS-6 through pinned `ts-fsrs` 5.4.2. Defaults preserve the previous extension's setup: 90% retention, learning steps of 1 and 10 minutes, a 10-minute relearning step, no fuzz, and a maximum interval of 36,525 days. Review-state cards are due by calendar day in the local timezone; learning cards wait until their exact due time. A short learning step can return later in the same open session.

Existing FSRS scheduling stays in the same inline format:

```text
<!--SR:!fsrs,due,interval,stability,difficulty,state,reps,lapses,learningSteps,lastReview-->
```

Dates are UTC ISO timestamps. Sibling records are concatenated with `!fsrs`; an absent record is new. Current state remains transferable by a future script. There is no import/export UI, separate database, or review-history log. This shares RemNote's optional FSRS algorithm and rating labels; it does not claim identical RemNote settings or guaranteed import compatibility.

Only review and deletion write to notes. Updates use `Vault.process`; if the note changed since it was loaded, the action stops and asks you to reopen the reviewer. Unsupported schedules are reported rather than silently reset.

## Build and install

```sh
npm ci
npm run check
```

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/minimal-flashcards/` in the intended vault, then enable **Minimal Flashcards** in Community plugins. Disable the previous Spaced Repetition plugin to avoid two reviewers modifying the same schedules.

`npm test` covers parsing, source deletion, FSRS state, due ordering, and reviewer actions. Only `ts-fsrs` ships in the bundle; the Obsidian API comes from the host app. No network requests are made.
