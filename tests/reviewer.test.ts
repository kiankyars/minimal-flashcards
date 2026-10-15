import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import type * as Host from "./obsidian-mock";

const bundled = buildSync({
    stdin: {
        contents: 'export { default } from "./src/main"; export * from "./tests/obsidian-mock";',
        resolveDir: process.cwd(),
        loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { obsidian: resolve("tests/obsidian-mock.ts") },
});
const pluginModule = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(createRequire(resolve("package.json")), pluginModule, pluginModule.exports);
const host = pluginModule.exports as typeof Host & {
    default: new (app: any) => Host.Plugin & { onload(): void; onunload(): void };
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise((done) => setTimeout(done, 1));
    }
    assert.ok(predicate(), "reviewer did not reach the expected state");
}

function setup(t: TestContext, source: string | Record<string, string> = "#flashcards\n\nFirst::First answer\n\nSecond::Second answer\n") {
    const dom = new JSDOM("<!doctype html><body></body>");
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    host.installElementHelpers(dom.window);
    host.notices.length = 0;
    const notes = new Map(Object.entries(typeof source === "string" ? { "cards.md": source } : source));
    const files = [...notes.keys()].map((path) => new host.TFile(path));
    const file = files[0];
    const writes: Array<{ before: string; after?: string }> = [];
    const openedFiles: Array<{ file: Host.TFile; options: unknown }> = [];
    let gate: Promise<void> | undefined;
    let readGate: Promise<void> | undefined;
    let failure: Error | undefined;
    const app = {
        metadataCache: { getFileCache: () => null },
        vault: {
            getMarkdownFiles: () => files,
            cachedRead: async (file: Host.TFile) => { await readGate; return notes.get(file.path)!; },
            getFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
            process: async (file: Host.TFile, transform: (text: string) => string) => {
                let text = notes.get(file.path)!;
                const write: (typeof writes)[number] = { before: text };
                writes.push(write);
                await gate;
                if (failure) { const error = failure; failure = undefined; throw error; }
                text = transform(text);
                notes.set(file.path, text);
                write.after = text;
                return text;
            },
        },
        workspace: { getLeaf: () => ({ openFile: async (file: Host.TFile, options: unknown) => { openedFiles.push({ file, options }); } }) },
    };
    const plugin = new host.default(app);
    plugin.onload();
    t.mock.method(console, "error", () => {});
    t.after(() => {
        plugin.onunload();
        for (const modal of [...host.openedModals]) modal.close();
        dom.window.close();
    });
    const current = () => {
        assert.equal(host.openedModals.length, 1);
        return host.openedModals[0];
    };
    const button = (label: string) => {
        const element = [...current().contentEl.querySelectorAll("button")].find((element) =>
            element.textContent === label || element.getAttribute("aria-label")?.startsWith(`${label},`));
        assert.ok(element, `missing button: ${label}`);
        return element;
    };
    return {
        plugin, writes, openedFiles, current, button,
        source: (path = file.path) => notes.get(path)!,
        replaceSource: (value: string) => { notes.set(file.path, value); },
        blockWrite: (promise: Promise<void>) => { gate = promise; },
        blockRead: (promise: Promise<void>) => { readGate = promise; },
        failWrite: (error: Error) => { failure = error; },
        body: () => current().contentEl.querySelector(".mf-body")?.textContent,
        async open() {
            plugin.commands[0].callback();
            await until(() => host.openedModals.length === 1 && !!host.openedModals[0].contentEl.querySelector(".mf-actions, .mf-empty"));
        },
        async chooseDeck() {
            plugin.commands[1].callback();
            await until(() => host.openedModals.some((modal) => modal instanceof host.FuzzySuggestModal));
            return host.openedModals.find((modal) => modal instanceof host.FuzzySuggestModal) as Host.FuzzySuggestModal<string>;
        },
        async reveal() {
            button("Show answer").click();
            await until(() => !!current().contentEl.querySelector(".mf-ratings"));
        },
    };
}

test("Review all opens a card directly with one native close control and full RemNote labels", async (t) => {
    const ui = setup(t);
    assert.deepEqual(ui.plugin.commands.map(({ id, name }) => ({ id, name })), [
        { id: "review-all", name: "Review all cards" },
        { id: "review-deck", name: "Review a specific deck" },
    ]);
    await ui.open();
    assert.equal(ui.body(), "First");
    assert.deepEqual([...ui.current().contentEl.querySelectorAll("button")].map((button) => button.textContent), ["Open note", "Delete", "Show answer"]);
    assert.equal(ui.current().modalEl.querySelectorAll(".modal-close-button, [aria-label='Close']").length, 1);
    await ui.reveal();
    assert.equal(ui.body(), "FirstFirst answer");
    assert.equal(ui.current().contentEl.querySelectorAll(".mf-body hr").length, 1);
    assert.deepEqual([...ui.current().contentEl.querySelectorAll(".mf-ratings button > span")].map((span) => span.textContent), [
        "Forgot", "Partially recalled", "Recalled with effort", "Easily recalled",
    ]);
    assert.equal(ui.writes.length, 0);
});

test("the ribbon reviews all cards immediately, while canceling the native deck picker starts no review", async (t) => {
    const ui = setup(t, "#flashcards/chips/process\n\nFirst::Answer\n");
    const chooser = await ui.chooseDeck();
    assert.equal(chooser.inputEl.placeholder, "Search decks…");
    assert.deepEqual(chooser.getItems(), ["#flashcards/chips", "#flashcards/chips/process"]);
    assert.equal(chooser.getItemText("#flashcards/chips/process"), "chips/process");
    assert.equal(chooser.contentEl.querySelector(".mf-body"), null);
    chooser.close();
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(host.openedModals.length, 0);
    ui.plugin.ribbons[0]();
    await until(() => host.openedModals.length === 1 && ui.body() === "First");
    assert.equal(ui.current().titleEl.textContent, "Flashcards");
    assert.equal(ui.writes.length, 0);
});

test("a selected parent deck includes direct and descendant notes, excludes prefix lookalikes, and stays filtered after writes", async (t) => {
    const ui = setup(t, {
        "other.md": "#flashcards/other\n\nUnrelated::Answer\n",
        "similar.md": "#flashcards/chipsmith\n\nUnrelated prefix::Answer\n",
        "parent.md": "#flashcards/chips\n\nParent::Answer\n",
        "child.md": "#flashcards/chips/process\n\nChild::Answer\n",
        "fake.md": "#flashcards\n<!-- #flashcards/hidden -->\n`#flashcards/code`\n\nOther root card::Answer\n",
    });
    const chooser = await ui.chooseDeck();
    assert.deepEqual(chooser.getItems(), ["#flashcards/chips", "#flashcards/chips/process", "#flashcards/chipsmith", "#flashcards/other"]);
    chooser.onChooseItem("#flashcards/chips");
    await until(() => host.openedModals.length === 1 && ui.body() === "Parent");
    assert.equal(ui.current().titleEl.textContent, "Flashcards · chips");
    assert.equal(ui.current().contentEl.querySelector(".mf-count")?.textContent, "0 due · 2 new");
    ui.button("Delete").click();
    await until(() => ui.body() === "Child");
    ui.button("Delete").click();
    await until(() => !!ui.current().contentEl.querySelector(".mf-empty"));
    assert.equal(ui.writes.length, 2);
    assert.match(ui.source("other.md"), /Unrelated::Answer/);
    assert.match(ui.source("similar.md"), /Unrelated prefix::Answer/);
    assert.match(ui.source("fake.md"), /Other root card::Answer/);
});

test("a deleted question that removes the selected deck tag does not reload cards from another deck", async (t) => {
    const ui = setup(t, "#flashcards/other\n\n#flashcards/chips Question::Answer\n\nOther::Answer\n");
    const chooser = await ui.chooseDeck();
    chooser.onChooseItem("#flashcards/chips");
    await until(() => host.openedModals.length === 1 && ui.body() === "#flashcards/chips Question");
    ui.button("Delete").click();
    await until(() => !!ui.current().contentEl.querySelector(".mf-empty"));
    assert.equal(ui.source(), "#flashcards/other\n\nOther::Answer\n");
});

test("switching from a selected deck to all cards waits for a pending save and opens one fresh reviewer", async (t) => {
    const ui = setup(t, {
        "other.md": "#flashcards/other\n\nOther::Answer\n",
        "chips.md": "#flashcards/chips\n\nChip::Answer\n\nNext chip::Answer\n",
    });
    const chooser = await ui.chooseDeck();
    chooser.onChooseItem("#flashcards/chips");
    await until(() => host.openedModals.length === 1 && ui.body() === "Chip");
    const reviewer = ui.current();
    const waiting = deferred();
    ui.blockWrite(waiting.promise);
    ui.button("Delete").click();
    ui.plugin.commands[0].callback();
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(ui.current(), reviewer);
    assert.equal(ui.current().titleEl.textContent, "Flashcards · chips");
    waiting.resolve();
    await until(() => host.openedModals.length === 1 && ui.current() !== reviewer && ui.body() === "Other");
    assert.equal(ui.current().titleEl.textContent, "Flashcards");
    assert.equal(ui.current().contentEl.querySelector(".mf-count")?.textContent, "0 due · 2 new");
    assert.equal(ui.writes.length, 1);
    assert.equal(ui.source("chips.md"), "#flashcards/chips\n\nNext chip::Answer\n");
});

test("canceling a picker preserves an open reviewer, and unloading closes both", async (t) => {
    const ui = setup(t, "#flashcards/chips\n\nFirst::Answer\n");
    await ui.open();
    const reviewer = ui.current();
    const chooser = await ui.chooseDeck();
    assert.equal(host.openedModals.length, 2);
    chooser.close();
    assert.equal(ui.current(), reviewer);
    await ui.chooseDeck();
    ui.plugin.onunload();
    assert.equal(host.openedModals.length, 0);
});

test("unloading while deck discovery reads notes prevents a late picker from opening", async (t) => {
    const ui = setup(t, "#flashcards/chips\n\nFirst::Answer\n");
    const waiting = deferred();
    ui.blockRead(waiting.promise);
    ui.plugin.commands[1].callback();
    await new Promise((done) => setTimeout(done, 0));
    ui.plugin.onunload();
    waiting.resolve();
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(host.openedModals.length, 0);
});

test("rating shortcuts require a revealed answer and ignore key repeats", async (t) => {
    const ui = setup(t);
    await ui.open();
    ui.current().key("4");
    ui.current().key(" ", true);
    assert.equal(ui.writes.length, 0);
    assert.equal(ui.body(), "First");
    ui.current().key(" ");
    await until(() => !!ui.current().contentEl.querySelector(".mf-ratings"));
    ui.current().key("4", true);
    assert.equal(ui.writes.length, 0);
    ui.current().key("4");
    await until(() => ui.body() === "Second");
    assert.equal(ui.writes.length, 1);
    assert.match(ui.source(), /First::First answer <!--SR:!fsrs,/);
});

test("Delete immediately removes the whole cloze question and its siblings without a confirmation or blank residue", async (t) => {
    const ui = setup(t, "#flashcards\n\nA ==red== and ==blue==.\n\nNext::Answer\n");
    await ui.open();
    assert.equal(ui.current().contentEl.querySelector(".mf-count")?.textContent, "0 due · 3 new");
    ui.button("Delete").click();
    assert.equal(ui.writes.length, 1);
    await until(() => ui.body() === "Next");
    assert.equal(ui.source(), "#flashcards\n\nNext::Answer\n");
    assert.equal(ui.current().contentEl.querySelector(".mf-count")?.textContent, "0 due · 1 new");
    assert.equal(host.openedModals.length, 1);
    assert.deepEqual(host.notices, []);
});

test("a pending deletion ignores double clicks and rating shortcuts", async (t) => {
    const ui = setup(t);
    await ui.open();
    await ui.reveal();
    const waiting = deferred();
    ui.blockWrite(waiting.promise);
    const remove = ui.button("Delete");
    remove.click();
    remove.dispatchEvent(new window.Event("click"));
    ui.current().key("4");
    assert.equal(ui.writes.length, 1);
    assert.ok([...ui.current().contentEl.querySelectorAll("button")].every((button) => button.disabled));
    assert.match(ui.source(), /First::First answer/);
    waiting.resolve();
    await until(() => ui.body() === "Second");
    assert.equal(ui.writes.length, 1);
    assert.equal(ui.source(), "#flashcards\n\nSecond::Second answer\n");
});

test("a failed write keeps the current card and permits a single retry", async (t) => {
    const ui = setup(t);
    const original = ui.source();
    await ui.open();
    ui.failWrite(new Error("Disk write failed"));
    ui.button("Delete").click();
    await until(() => host.notices.length === 1 && !ui.button("Delete").disabled);
    assert.equal(ui.source(), original);
    assert.equal(ui.body(), "First");
    assert.deepEqual(host.notices, ["Disk write failed"]);
    ui.button("Delete").click();
    await until(() => ui.body() === "Second");
    assert.equal(ui.writes.length, 2);
});

test("closing and reopening during a write waits for the save and reloads the resulting note", async (t) => {
    const ui = setup(t);
    await ui.open();
    const waiting = deferred();
    ui.blockWrite(waiting.promise);
    ui.button("Delete").click();
    ui.current().close();
    ui.plugin.commands[0].callback();
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(host.openedModals.length, 0);
    assert.equal(ui.writes.length, 1);
    waiting.resolve();
    await until(() => host.openedModals.length === 1 && host.openedModals[0].contentEl.querySelector(".mf-body")?.textContent === "Second");
    assert.equal(ui.source(), "#flashcards\n\nSecond::Second answer\n");
    assert.equal(ui.writes.length, 1);
});

test("a note edited during review is not overwritten or deleted", async (t) => {
    const ui = setup(t);
    await ui.open();
    const edited = ui.source().replace("First answer", "Edited answer");
    ui.replaceSource(edited);
    ui.button("Delete").click();
    await until(() => host.notices.length === 1 && !ui.button("Delete").disabled);
    assert.equal(ui.source(), edited);
    assert.equal(ui.body(), "First");
    assert.match(host.notices[0], /note changed/);
    assert.equal(ui.writes[0].after, undefined);
});

test("Open note navigates to the current source line and closes the reviewer", async (t) => {
    const ui = setup(t);
    await ui.open();
    ui.button("Open note").click();
    await until(() => host.openedModals.length === 0);
    assert.equal(ui.openedFiles.length, 1);
    assert.equal(ui.openedFiles[0].file.path, "cards.md");
    assert.deepEqual(ui.openedFiles[0].options, { eState: { line: 2 } });
    assert.equal(ui.writes.length, 0);
});
