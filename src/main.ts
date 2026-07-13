import {
  App,
  Keymap,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  getAllTags,
  getLanguage,
} from "obsidian";
import {
  KatazukeSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  outDegree,
  computeBacklinkCounts,
  rankNotes,
  NoteInput,
  ScoredNote,
  Strings,
  STRINGS,
  pickLang,
} from "./lib";

export default class KatazukePlugin extends Plugin {
  settings: KatazukeSettings = DEFAULT_SETTINGS;
  strings: Strings = STRINGS.en;

  async onload() {
    await this.loadSettings();
    this.strings = STRINGS[pickLang(getLanguage())];

    this.addCommand({
      id: "confront-one",
      name: this.strings.confrontOne,
      callback: () => this.showRanked(1),
    });

    this.addCommand({
      id: "confront-several",
      name: this.strings.confrontSeveral,
      callback: () => this.showRanked(this.settings.batchSize),
    });

    this.addSettingTab(new KatazukeSettingTab(this.app, this));
  }

  // Build note inputs from the resolved link graph + file mtime + tags.
  // Backlink counts come from a single reverse-index pass over resolvedLinks so
  // the total matches Obsidian's backlink pane; media links are excluded.
  private collect(): NoteInput[] {
    const links = this.app.metadataCache.resolvedLinks;
    const inbound = computeBacklinkCounts(links);
    const hubTag = normalizeTag(this.settings.hubTag);

    const inputs: NoteInput[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      inputs.push({
        path: file.path,
        inDeg: inbound.get(file.path) ?? 0,
        outDeg: outDegree(file.path, links[file.path] ?? {}),
        mtimeMs: file.stat.mtime,
        hasHubTag: this.fileHasTag(file, hubTag),
      });
    }
    return inputs;
  }

  private fileHasTag(file: TFile, hubTag: string): boolean {
    if (!hubTag) return false;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return false;
    const tags = getAllTags(cache) ?? [];
    return tags.some((t) => normalizeTag(t) === hubTag);
  }

  private showRanked(limit: number) {
    const ranked = rankNotes(this.collect(), this.settings, Date.now());
    if (ranked.length === 0) {
      new Notice(this.strings.noResults);
      return;
    }
    new KatazukeModal(this.app, ranked.slice(0, limit), this.strings).open();
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<KatazukeSettings> | null;
    this.settings = mergeSettings(data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").trim().toLowerCase();
}

class KatazukeModal extends Modal {
  constructor(
    app: App,
    private notes: ScoredNote[],
    private strings: Strings,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("katazuke-modal");
    contentEl.createEl("div", {
      cls: "katazuke-heading",
      text: this.strings.heading,
    });
    const list = contentEl.createEl("div", { cls: "katazuke-list" });

    for (const note of this.notes) {
      const result = list.createEl("div", { cls: "katazuke-result" });
      const titleRow = result.createEl("div", { cls: "katazuke-title-row" });
      const link = titleRow.createEl("a", {
        text: note.path.replace(/\.md$/, ""),
        cls: "katazuke-title",
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        // Browser-like: plain click opens in place and closes the modal;
        // Cmd/Ctrl+click opens in a new tab and keeps the modal open so you
        // can keep triaging candidates.
        const paneType = Keymap.isModEvent(e); // "tab" when mod held, else false
        void this.app.workspace.openLinkText(note.path, "", paneType);
        if (!paneType) this.close();
      });
      const s = this.strings;
      titleRow.createEl("span", {
        cls: "katazuke-score",
        text: `${s.scoreLabel} ${note.score.toFixed(1)}`,
      });
      result.createEl("div", {
        cls: "katazuke-meta",
        text: `${s.backlinksLabel} ${note.inDeg} ・ ${s.outgoingLabel} ${note.outDeg} ・ ${Math.round(note.ageDays)}${s.daysSuffix}`,
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class KatazukeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: KatazukePlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.strings;
    containerEl.empty();

    new Setting(containerEl)
      .setName(s.hubTagName)
      .setDesc(s.hubTagDesc)
      .addText((t) =>
        t
          .setValue(this.plugin.settings.hubTag)
          .onChange(async (v) => {
            this.plugin.settings.hubTag = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(s.halfLifeName)
      .setDesc(s.halfLifeDesc)
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.freshnessHalfLifeDays))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.freshnessHalfLifeDays = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName(s.batchSizeName)
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.batchSize))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) {
              this.plugin.settings.batchSize = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName(s.minDegreeName)
      .setDesc(s.minDegreeDesc)
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.minDegree))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 0) {
              this.plugin.settings.minDegree = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
