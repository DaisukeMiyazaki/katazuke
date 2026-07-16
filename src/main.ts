import {
  App,
  Keymap,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  getAllTags,
  getLanguage,
} from "obsidian";
import {
  KatazukeSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  outDegree,
  computeBacklinkCounts,
  formatLogLine,
  isUnderFolder,
  lastNDays,
  localIso,
  parseLog,
  rankNotes,
  selectClutter,
  NoteInput,
  ClutterNote,
  MountainTheme,
  ScoredNote,
  Strings,
  STRINGS,
  pickLang,
} from "./lib";
import { MountainView, MOUNTAIN_VIEW_TYPE, PaletteChoice } from "./view";

export default class KatazukePlugin extends Plugin {
  settings: KatazukeSettings = DEFAULT_SETTINGS;
  strings: Strings = STRINGS.en;
  // Notes judged this session are hidden from the mountain so it visibly
  // settles as you work. Session-only: nothing is written to the vault.
  private judged = new Set<string>();

  async onload() {
    await this.loadSettings();
    this.strings = STRINGS[pickLang(getLanguage())];

    this.registerView(
      MOUNTAIN_VIEW_TYPE,
      (leaf) =>
        new MountainView(
          leaf,
          this.strings,
          () => this.clutter(),
          () => this.settings.batchSize,
          () => this.settings.pileSize,
          () => this.paletteChoice(),
          (path) => this.judge(path),
        ),
    );

    // Follow live theme/accent changes when the mountain matches Obsidian.
    this.registerEvent(
      this.app.workspace.on("css-change", () => this.repaintMountains()),
    );

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

    this.addCommand({
      id: "open-mountain",
      name: this.strings.openMountain,
      callback: () => void this.activateMountain(),
    });

    this.addRibbonIcon("mountain", this.strings.openMountain, () =>
      void this.activateMountain(),
    );

    this.addSettingTab(new KatazukeSettingTab(this.app, this));
  }

  // Stale orphans that haven't been judged yet this session.
  private clutter(): ClutterNote[] {
    return selectClutter(
      this.collect(),
      Date.now(),
      this.settings.clutterStaleDays,
    ).filter((n) => !this.judged.has(n.path));
  }

  // Judging a candidate: open it beside the mountain so the user can decide
  // (keep / shelve / drop) — but WITHOUT moving focus, so the dot visibly
  // vanishes and the mound settles while you watch. One side pane is reused
  // across judgments instead of splitting again per click.
  private judgeLeaf: WorkspaceLeaf | null = null;

  private judge(path: string): void {
    this.judged.add(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      if (!this.judgeLeaf || !this.isLeafAlive(this.judgeLeaf)) {
        // The mountain sits in the sidebar, so anchor the reading pane to the
        // most recent MAIN-area leaf; splitting whatever happens to be active
        // could split the sidebar itself.
        const recent = this.app.workspace.getMostRecentLeaf(
          this.app.workspace.rootSplit,
        );
        this.judgeLeaf = recent
          ? this.app.workspace.createLeafBySplit(recent)
          : this.app.workspace.getLeaf(true);
      }
      void this.judgeLeaf.openFile(file, { active: false });
    }
    void this.appendLog(path);
    this.refreshMountains();
  }

  // Record the judgment in the vault log — the durable, syncable history.
  private async appendLog(path: string): Promise<void> {
    try {
      const line = formatLogLine(localIso(new Date()), path);
      const logPath = this.settings.logPath;
      const existing = this.app.vault.getAbstractFileByPath(logPath);
      if (existing instanceof TFile) {
        await this.app.vault.append(existing, line);
      } else if (!existing) {
        await this.app.vault.create(
          logPath,
          this.strings.logHeader + "\n\n" + line,
        );
      }
    } catch (e) {
      console.error("katazuke: failed to append log", e);
    }
  }

  refreshMountains(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MOUNTAIN_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MountainView) view.refresh();
    }
  }

  // Resolve settings + live Obsidian state into concrete colors for the view.
  private paletteChoice(): PaletteChoice {
    const theme =
      this.settings.mountainTheme === "auto"
        ? document.body.classList.contains("theme-dark")
          ? "dark"
          : "light"
        : this.settings.mountainTheme;
    let accent: string | null = null;
    if (this.settings.useAccentColor) {
      const v = getComputedStyle(document.body)
        .getPropertyValue("--interactive-accent")
        .trim();
      accent = v || null;
    }
    return { theme, accent };
  }

  repaintMountains(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MOUNTAIN_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MountainView) view.repaint();
    }
  }

  // A leaf the user closed is gone from the workspace; splitting from it would
  // throw, so verify it is still attached before reuse.
  private isLeafAlive(leaf: WorkspaceLeaf): boolean {
    let alive = false;
    this.app.workspace.iterateAllLeaves((l) => {
      if (l === leaf) alive = true;
    });
    return alive;
  }

  // Reveal the mountain, reusing an open one rather than stacking duplicates.
  // It lives in the right side panel — a small companion always at hand, not a
  // full-width tab whose emptiness dwarfs the mound.
  private async activateMountain(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(MOUNTAIN_VIEW_TYPE);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: MOUNTAIN_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
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
      if (isUnderFolder(file.path, this.settings.excludedFolders)) continue;
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
    contentEl.createDiv({
      cls: "katazuke-heading",
      text: this.strings.heading,
    });
    const list = contentEl.createDiv({ cls: "katazuke-list" });

    for (const note of this.notes) {
      const result = list.createDiv({ cls: "katazuke-result" });
      const titleRow = result.createDiv({ cls: "katazuke-title-row" });
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
      titleRow.createSpan({
        cls: "katazuke-score",
        text: `${s.scoreLabel} ${note.score.toFixed(1)}`,
      });
      result.createDiv({
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

    new Setting(containerEl)
      .setName(s.pileSizeName)
      .setDesc(s.pileSizeDesc)
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.pileSize))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) {
              this.plugin.settings.pileSize = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName(s.staleDaysName)
      .setDesc(s.staleDaysDesc)
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.clutterStaleDays))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.clutterStaleDays = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl).setName(s.themeName).addDropdown((d) =>
      d
        .addOption("auto", s.themeAuto)
        .addOption("light", s.themeLight)
        .addOption("dark", s.themeDark)
        .setValue(this.plugin.settings.mountainTheme)
        .onChange(async (v) => {
          this.plugin.settings.mountainTheme = v as MountainTheme;
          await this.plugin.saveSettings();
          this.plugin.repaintMountains();
        }),
    );

    new Setting(containerEl)
      .setName(s.accentName)
      .setDesc(s.accentDesc)
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.useAccentColor)
          .onChange(async (v) => {
            this.plugin.settings.useAccentColor = v;
            await this.plugin.saveSettings();
            this.plugin.repaintMountains();
          }),
      );

    // Excluded folders: a dropdown of the vault's folders (minus those already
    // excluded) adds on select; each exclusion below gets a remove button.
    new Setting(containerEl)
      .setName(s.excludeName)
      .setDesc(s.excludeDesc)
      .addDropdown((d) => {
        d.addOption("", s.excludeSelect);
        const folders = this.app.vault
          .getAllFolders()
          .map((f) => f.path)
          .filter((p) => !this.plugin.settings.excludedFolders.includes(p))
          .sort();
        for (const p of folders) d.addOption(p, p);
        d.onChange(async (v) => {
          if (!v) return;
          this.plugin.settings.excludedFolders.push(v);
          await this.plugin.saveSettings();
          this.plugin.refreshMountains();
          this.display();
        });
      });

    for (const folder of this.plugin.settings.excludedFolders) {
      new Setting(containerEl).setName(folder).addExtraButton((b) =>
        b
          .setIcon("x")
          .setTooltip(s.excludeRemove)
          .onClick(async () => {
            this.plugin.settings.excludedFolders =
              this.plugin.settings.excludedFolders.filter((f) => f !== folder);
            await this.plugin.saveSettings();
            this.plugin.refreshMountains();
            this.display();
          }),
      );
    }

    new Setting(containerEl)
      .setName(s.logPathName)
      .setDesc(s.logPathDesc)
      .addText((t) =>
        t.setValue(this.plugin.settings.logPath).onChange(async (v) => {
          const p = v.trim();
          if (p) {
            this.plugin.settings.logPath = p;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl).setName(s.historyName).setHeading();
    const history = containerEl.createDiv({ cls: "katazuke-history-wrap" });
    void this.renderHistory(history);
  }

  // The trail: total tidied plus a 30-day bar chart, read fresh from the log
  // file (the vault copy is the source of truth, so other devices' judgments
  // show up here too once synced).
  private async renderHistory(el: HTMLElement): Promise<void> {
    const s = this.plugin.strings;
    const file = this.app.vault.getAbstractFileByPath(
      this.plugin.settings.logPath,
    );
    const history =
      file instanceof TFile
        ? parseLog(await this.app.vault.cachedRead(file))
        : { total: 0, byDay: {} };

    if (history.total === 0) {
      el.createDiv({ cls: "katazuke-history-empty", text: s.historyEmpty });
      return;
    }

    el.createDiv({
      cls: "katazuke-history-total",
      text: s.historyTotal.replace("{n}", String(history.total)),
    });

    const days = lastNDays(history.byDay, 30, localIso(new Date()));
    const max = Math.max(1, ...days.map((d) => d.count));
    const chart = el.createDiv({ cls: "katazuke-history-chart" });
    for (const d of days) {
      const col = chart.createDiv({ cls: "katazuke-history-col" });
      const bar = col.createDiv({ cls: "katazuke-history-bar" });
      bar.setCssProps({ "--katazuke-bar": `${(d.count / max) * 100}%` });
      if (d.count === 0) bar.addClass("katazuke-history-bar-zero");
      col.setAttr("aria-label", `${d.day}: ${d.count}`);
      col.setAttr("title", `${d.day}: ${d.count}`);
    }
    const axis = el.createDiv({ cls: "katazuke-history-axis" });
    axis.createSpan({ text: days[0].day });
    axis.createSpan({ text: days[days.length - 1].day });
  }
}
