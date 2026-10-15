// Only host APIs are mocked: the bundled plugin, parser, queue and FSRS run normally.
export const notices: string[] = [];
export const openedModals: Modal[] = [];

export function installElementHelpers(window: any): void {
    const prototype = window.HTMLElement.prototype;
    prototype.addClass = function (...classes: string[]) { this.classList.add(...classes); };
    prototype.setText = function (text: string) { this.textContent = text; };
    prototype.empty = function () { this.replaceChildren(); };
    prototype.createEl = function (tag: string, options: { text?: string; cls?: string } = {}) {
        const element = window.document.createElement(tag);
        if (options.text !== undefined) element.textContent = options.text;
        if (options.cls) element.className = options.cls;
        this.append(element);
        return element;
    };
    prototype.createDiv = function (options: object) { return this.createEl("div", options); };
    prototype.createSpan = function (options: object) { return this.createEl("span", options); };
}

export class Component {
    load(): void {}
    unload(): void {}
}

export class TFile {
    constructor(public path: string) {}
}

export class Plugin {
    commands: Array<{ id: string; name: string; callback: () => void }> = [];
    ribbons: Array<() => void> = [];
    constructor(public app: any) {}
    addCommand(command: Plugin["commands"][number]): void { this.commands.push(command); }
    addRibbonIcon(_icon: string, _name: string, callback: () => void): void { this.ribbons.push(callback); }
}

export class Modal {
    modalEl = document.createElement("div");
    titleEl = this.modalEl.appendChild(document.createElement("h2"));
    contentEl = this.modalEl.appendChild(document.createElement("div"));
    private keys = new Map<string, (event: { repeat: boolean }) => boolean>();
    scope = {
        register: (_modifiers: string[], key: string, callback: (event: { repeat: boolean }) => boolean) => {
            this.keys.set(key, callback);
        },
    };

    constructor(public app: any) {
        // Obsidian supplies this control; the plugin must not add a second one.
        const close = this.modalEl.appendChild(document.createElement("button"));
        close.className = "modal-close-button";
        close.setAttribute("aria-label", "Close");
        close.addEventListener("click", () => this.close());
    }

    open(): void {
        openedModals.push(this);
        document.body.append(this.modalEl);
        this.onOpen();
    }
    close(): void {
        const index = openedModals.indexOf(this);
        if (index === -1) return;
        openedModals.splice(index, 1);
        this.onClose();
        this.modalEl.remove();
    }
    key(key: string, repeat = false): void { this.keys.get(key)?.({ repeat }); }
    onOpen(): void {}
    onClose(): void {}
}

export abstract class FuzzySuggestModal<T> extends Modal {
    inputEl = document.createElement("input");
    emptyStateText = "";
    abstract getItems(): T[];
    abstract getItemText(item: T): string;
    abstract onChooseItem(item: T): void;
    setPlaceholder(text: string): void { this.inputEl.placeholder = text; }
    onOpen(): void { this.contentEl.append(this.inputEl); }
}

export class Notice {
    constructor(message: string, _duration?: number) { notices.push(message); }
}

export function getAllTags(cache: { tags?: Array<{ tag: string }> }): string[] | null {
    return cache.tags?.map(({ tag }) => tag) ?? null;
}

export const MarkdownRenderer = {
    async render(_app: unknown, markdown: string, container: HTMLElement): Promise<void> {
        container.textContent = markdown;
    },
};
