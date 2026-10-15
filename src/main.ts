import { Component, FuzzySuggestModal, getAllTags, MarkdownRenderer, Modal, Notice, Plugin, TFile, type App } from "obsidian";
import { deleteQuestion, flashcardTags, isFlashcardNote, updateSchedules } from "./cards";
import { cardsFromNote, readyCards, type ReviewCard } from "./queue";
import { formatInterval, preview, readSchedule, REMNOTE_RATINGS, State, writeSchedule, type Grade } from "./scheduler";

export default class MinimalFlashcards extends Plugin {
    private reviewer?: Reviewer;
    private chooser?: DeckPicker;
    private pendingWrite?: Promise<void>;
    private request = 0;
    private unloaded = false;

    onload(): void {
        this.addCommand({ id: "review-all", name: "Review all cards", callback: () => void this.openReviewer() });
        this.addCommand({ id: "review-deck", name: "Review a specific deck", callback: () => void this.chooseDeck() });
        this.addRibbonIcon("layers", "Review all cards", () => void this.openReviewer());
    }

    onunload(): void {
        this.unloaded = true;
        this.request++;
        this.chooser?.close();
        this.reviewer?.close();
    }

    private async openReviewer(deck?: string): Promise<void> {
        const request = ++this.request;
        this.chooser?.close();
        try {
            await this.pendingWrite;
            if (this.unloaded || request !== this.request || (this.reviewer && this.reviewer.deck === deck)) return;
            this.reviewer?.close();
            this.reviewer = new Reviewer(this, deck);
            this.reviewer.open();
        } catch (error) {
            if (!this.unloaded && request === this.request) this.report(error);
        }
    }

    private async chooseDeck(): Promise<void> {
        if (this.chooser) return;
        const request = ++this.request;
        try {
            await this.pendingWrite;
            if (this.unloaded || request !== this.request) return;
            const tags = await Promise.all(flashcardFiles(this.app).map(async (file) => flashcardTags(await this.app.vault.cachedRead(file))));
            if (this.unloaded || request !== this.request) return;
            const decks = new Set<string>();
            for (const tag of tags.flat()) {
                const parts = tag.split("/");
                for (let length = 2; length <= parts.length; length++) decks.add(parts.slice(0, length).join("/"));
            }
            const chooser = new DeckPicker(this.app, [...decks].sort(), (deck) => void this.openReviewer(deck), () => {
                if (this.chooser === chooser) this.chooser = undefined;
            });
            this.chooser = chooser;
            chooser.open();
        } catch (error) {
            if (!this.unloaded && request === this.request) this.report(error);
        }
    }

    release(reviewer: Reviewer): void {
        if (this.reviewer === reviewer) this.reviewer = undefined;
    }

    async write(action: () => Promise<void>): Promise<void> {
        if (this.pendingWrite) throw new Error("A card update is still being saved.");
        const pending = action();
        this.pendingWrite = pending;
        try {
            await pending;
        } finally {
            if (this.pendingWrite === pending) this.pendingWrite = undefined;
        }
    }

    report(error: unknown): void {
        new Notice(error instanceof Error ? error.message : "Could not update the card.", 8000);
        console.error("Minimal Flashcards:", error);
    }
}

function flashcardFiles(app: App, deck = "#flashcards"): TFile[] {
    return app.vault.getMarkdownFiles().filter((file) => {
        const cache = app.metadataCache.getFileCache(file);
        return !cache || (getAllTags(cache) ?? []).some((tag) => tag === deck || tag.startsWith(`${deck}/`));
    });
}

class DeckPicker extends FuzzySuggestModal<string> {
    constructor(app: App, private decks: string[], private choose: (deck: string) => void, private dismiss: () => void) {
        super(app);
        this.setPlaceholder("Search decks…");
        this.emptyStateText = "No decks found. Use #flashcards/deck-name in a note.";
    }

    getItems(): string[] { return this.decks; }
    getItemText(deck: string): string { return deck.slice("#flashcards/".length); }
    onChooseItem(deck: string): void {
        this.close();
        this.choose(deck);
    }
    onClose(): void {
        super.onClose();
        this.dismiss();
    }
}

class Reviewer extends Modal {
    private cards: ReviewCard[] = [];
    private current?: ReviewCard;
    private revealed = false;
    private busy = true;
    private closed = false;
    private renderId = 0;
    private markdown?: Component;
    private wakeTimer?: number;

    constructor(private plugin: MinimalFlashcards, readonly deck?: string) {
        super(plugin.app);
        this.scope.register([], " ", (event) => {
            if (!event.repeat && !this.busy && !this.revealed && this.current) void this.reveal();
            return false;
        });
        for (const { rating } of REMNOTE_RATINGS) {
            this.scope.register([], String(rating), (event) => {
                if (!event.repeat && this.revealed) void this.rate(rating);
                return false;
            });
        }
    }

    onOpen(): void {
        this.modalEl.addClass("minimal-flashcards");
        this.titleEl.setText(this.deck ? `Flashcards · ${this.deck.slice("#flashcards/".length)}` : "Flashcards");
        this.contentEl.setText("Loading cards…");
        void this.load();
    }

    onClose(): void {
        this.closed = true;
        this.renderId++;
        if (this.wakeTimer !== undefined) window.clearInterval(this.wakeTimer);
        this.markdown?.unload();
        this.plugin.release(this);
        this.contentEl.empty();
    }

    private async load(): Promise<void> {
        try {
            const now = new Date();
            const files = flashcardFiles(this.app, this.deck);
            const notes = await Promise.all(files.map(async (file) => {
                const text = await this.app.vault.cachedRead(file);
                if (!isFlashcardNote(text, this.deck)) return [];
                try {
                    return cardsFromNote(file.path, text, now);
                } catch (error) {
                    throw new Error(`${file.path}: ${error instanceof Error ? error.message : "Could not read cards."}`);
                }
            }));
            this.cards = notes.flat();
            await this.advance();
            if (!this.closed) {
                this.wakeTimer = window.setInterval(() => {
                    if (!this.busy && !this.current && readyCards(this.cards, new Date()).length) void this.advance();
                }, 1000);
            }
        } catch (error) {
            if (!this.closed) {
                this.contentEl.setText("Could not load cards. Close and reopen to try again.");
                this.plugin.report(error);
            }
        }
    }

    private async advance(): Promise<void> {
        if (this.closed) return;
        this.current = readyCards(this.cards, new Date())[0];
        this.revealed = false;
        await this.render();
    }

    private async reveal(): Promise<void> {
        if (this.busy || this.closed || !this.current || this.revealed) return;
        this.revealed = true;
        await this.render();
    }

    private async render(): Promise<void> {
        if (this.closed) return;
        this.busy = true;
        const id = ++this.renderId;
        this.markdown?.unload();
        this.markdown = new Component();
        this.markdown.load();
        this.contentEl.empty();
        const current = this.current;
        try {
            if (!current) {
                this.contentEl.createEl("p", { text: "All caught up.", cls: "mf-empty" });
                const upcoming = this.cards.filter((card) => card.schedule.state !== State.New)
                    .sort((a, b) => a.schedule.due.getTime() - b.schedule.due.getTime())[0];
                if (upcoming) this.contentEl.createEl("p", { text: `Next card in ${formatInterval(upcoming.schedule.due, new Date())}.`, cls: "mf-next" });
                return;
            }
            const toolbar = this.contentEl.createDiv({ cls: "mf-toolbar" });
            const remaining = readyCards(this.cards, new Date());
            const due = remaining.filter((card) => card.schedule.state !== State.New).length;
            toolbar.createSpan({ text: `${due} due · ${remaining.length - due} new`, cls: "mf-count" });
            this.button(toolbar, "Open note", () => void this.openNote());
            this.button(toolbar, "Delete", () => void this.remove(), "mf-delete");
            const basename = current.path.split("/").pop()?.replace(/\.md$/, "") ?? current.path;
            this.contentEl.createEl("p", { text: [basename, current.question.context].filter(Boolean).join(" › "), cls: "mf-context" });
            const body = this.contentEl.createDiv({ cls: "mf-body markdown-preview-view" });
            const variant = current.question.variants[current.variant];
            if (this.revealed && !current.question.cloze) {
                const front = body.createDiv();
                await MarkdownRenderer.render(this.app, variant.front, front, current.path, this.markdown);
                if (this.closed || id !== this.renderId) return;
                body.createEl("hr");
            }
            const face = body.createDiv();
            await MarkdownRenderer.render(this.app, this.revealed ? variant.back : variant.front, face, current.path, this.markdown);
            if (this.closed || id !== this.renderId) return;
            const actions = this.contentEl.createDiv({ cls: "mf-actions" });
            if (!this.revealed) {
                this.button(actions, "Show answer", () => void this.reveal(), "mod-cta mf-show");
                actions.createSpan({ text: "Space", cls: "mf-shortcut" });
            } else {
                const now = new Date();
                const choices = preview(current.schedule, now);
                actions.addClass("mf-ratings");
                for (const { rating, label } of REMNOTE_RATINGS) {
                    const button = this.button(actions, "", () => void this.rate(rating));
                    button.setAttribute("aria-label", `${label}, ${formatInterval(choices[rating].card.due, now)}`);
                    button.createSpan({ text: label });
                    button.createEl("small", { text: `${rating} · ${formatInterval(choices[rating].card.due, now)}` });
                }
            }
        } catch (error) {
            if (!this.closed) this.plugin.report(error);
        } finally {
            if (id === this.renderId) this.busy = false;
        }
    }

    private button(parent: HTMLElement, text: string, action: () => void, cls?: string): HTMLButtonElement {
        const button = parent.createEl("button", { text, cls });
        button.addEventListener("click", action);
        return button;
    }

    private async mutate(transform: (text: string, current: ReviewCard, now: Date) => string): Promise<void> {
        const current = this.current;
        if (this.busy || this.closed || !current) return;
        this.busy = true;
        this.contentEl.querySelectorAll("button").forEach((button) => { button.disabled = true; });
        try {
            await this.plugin.write(async () => {
                const file = this.app.vault.getFileByPath(current.path);
                if (!file) throw new Error("The card’s note no longer exists. Close and reopen the reviewer.");
                const now = new Date();
                const updated = await this.app.vault.process(file, (text) => {
                    if (text !== current.snapshot) {
                        throw new Error("This note changed while you were reviewing. Close and reopen the reviewer to refresh it.");
                    }
                    return transform(text, current, now);
                });
                this.cards = this.cards.filter((card) => card.path !== current.path);
                if (isFlashcardNote(updated, this.deck)) this.cards.push(...cardsFromNote(file.path, updated, now));
            });
            await this.advance();
        } catch (error) {
            if (!this.closed) {
                this.plugin.report(error);
                await this.render();
            }
        } finally {
            this.busy = false;
        }
    }

    private async rate(rating: Grade): Promise<void> {
        if (!this.revealed) return;
        await this.mutate((text, current, now) => {
            const tokens = [...current.question.schedules];
            for (let i = 0; i < current.question.variants.length; i++) {
                if (!tokens[i]) tokens[i] = writeSchedule(readSchedule(undefined, now));
            }
            tokens[current.variant] = writeSchedule(preview(current.schedule, now)[rating].card);
            return updateSchedules(text, current.question, tokens);
        });
    }

    private async remove(): Promise<void> {
        await this.mutate((text, current) => deleteQuestion(text, current.question));
    }

    private async openNote(): Promise<void> {
        if (this.busy || this.closed || !this.current) return;
        this.busy = true;
        this.contentEl.querySelectorAll("button").forEach((button) => { button.disabled = true; });
        const current = this.current;
        const file = this.app.vault.getFileByPath(current.path);
        if (!(file instanceof TFile)) {
            this.plugin.report(new Error("The card’s note no longer exists."));
            await this.render();
            return;
        }
        try {
            const text = await this.app.vault.cachedRead(file);
            const line = text.slice(0, current.question.start).split("\n").length - 1;
            await this.app.workspace.getLeaf(false).openFile(file, { eState: { line } });
            this.close();
        } catch (error) {
            this.plugin.report(error);
            await this.render();
        }
    }
}
