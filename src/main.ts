import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  getAllTags,
} from "obsidian";
import {
  KatazukeSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  outDegree,
  isMediaPath,
  rankNotes,
  NoteInput,
  ScoredNote,
} from "./lib";

export default class KatazukePlugin extends Plugin {
  settings: KatazukeSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "katazuke-one",
      name: "一件と向き合う",
      callback: () => this.showRanked(1),
    });

    this.addCommand({
      id: "katazuke-batch",
      name: "数件と向き合う",
      callback: () => this.showRanked(this.settings.batchSize),
    });

    this.addSettingTab(new KatazukeSettingTab(this.app, this));
  }

  // Build note inputs from the resolved link graph + file mtime + tags.
  // Backlinks come from getBacklinksForFile so the count matches Obsidian's
  // backlink pane (total mentions, embeds included); media links are excluded.
  private collect(): NoteInput[] {
    const links = this.app.metadataCache.resolvedLinks;
    const hubTag = normalizeTag(this.settings.hubTag);

    const inputs: NoteInput[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      inputs.push({
        path: file.path,
        inDeg: this.backlinkCount(file),
        outDeg: outDegree(file.path, links[file.path] ?? {}),
        mtimeMs: file.stat.mtime,
        hasHubTag: this.fileHasTag(file, hubTag),
      });
    }
    return inputs;
  }

  // Count backlinks the same way Obsidian's pane does: total linked mentions
  // across source notes, excluding any media source.
  private backlinkCount(file: TFile): number {
    // getBacklinksForFile is not in the public typings.
    const mc = this.app.metadataCache as unknown as {
      getBacklinksForFile?: (f: TFile) => { data: unknown };
    };
    const result = mc.getBacklinksForFile?.(file);
    if (!result) return 0;

    let count = 0;
    for (const [source, refs] of backlinkEntries(result.data)) {
      if (isMediaPath(source)) continue;
      count += Array.isArray(refs) ? refs.length : 0;
    }
    return count;
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
      new Notice("向き合う対象が見つかりませんでした");
      return;
    }
    new KatazukeModal(this.app, ranked.slice(0, limit)).open();
  }

  async loadSettings() {
    this.settings = mergeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").trim().toLowerCase();
}

// getBacklinksForFile's `.data` is a Map in current Obsidian and a plain object
// in older builds; normalize both to [sourcePath, refs] pairs.
function backlinkEntries(data: unknown): [string, unknown][] {
  if (!data) return [];
  if (data instanceof Map) return Array.from(data.entries());
  if (typeof data === "object") return Object.entries(data as Record<string, unknown>);
  return [];
}

class KatazukeModal extends Modal {
  constructor(app: App, private notes: ScoredNote[]) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "片付けの候補" });
    const list = contentEl.createEl("div", { cls: "katazuke-list" });

    for (const note of this.notes) {
      const row = list.createEl("div", { cls: "katazuke-row" });
      const link = row.createEl("a", {
        text: note.path.replace(/\.md$/, ""),
        cls: "katazuke-title",
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.app.workspace.openLinkText(note.path, "", false);
        this.close();
      });
      row.createEl("span", {
        cls: "katazuke-meta",
        text: `被リンク ${note.inDeg} ・ 発リンク ${note.outDeg} ・ ${Math.round(note.ageDays)}日 ・ 採点 ${note.score.toFixed(1)}`,
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
    containerEl.empty();

    new Setting(containerEl)
      .setName("ハブ除外タグ")
      .setDesc("意図的な目次ノートに付けるタグ。候補から除外する。")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.hubTag)
          .onChange(async (v) => {
            this.plugin.settings.hubTag = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("鮮度の半減期（日）")
      .setDesc("この日数だけ放置されると採点が2倍になる。")
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
      .setName("数件モードの件数")
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
      .setName("最小次数")
      .setDesc("この次数未満のノートは候補にしない。")
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
