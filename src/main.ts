import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TextAreaComponent,
  TextComponent,
  setIcon,
} from "obsidian";
import { DefaultIconsPage } from "./defaultIconsPage";
import { IconManager, Icons, validSvgRegEx } from "./iconManager";
import { processSvgContent, renderSvg } from "./svg";

interface IconSwapperSettings {
  autoReloadCommander: boolean;
}

// data.json 的完整结构（图标替换 + 自定义图标 + 插件设置）
type PluginData = {
  icons?: Icons;
  customIcons?: Icons;
  settings?: Partial<IconSwapperSettings>;
} | null;

const DEFAULT_SETTINGS: IconSwapperSettings = {
  autoReloadCommander: false,
};

// 连续删除图标时合并 Commander reload，避免每个操作都触发一次完整重启
const COMMANDER_RELOAD_DEBOUNCE_MS = 1000;

export default class IconSwapperPlugin extends Plugin {
  settingsTab: IconSwapperSettingsTab;
  iconManager: IconManager;
  settings: IconSwapperSettings = DEFAULT_SETTINGS;
  private commanderReloadTimer: number | null = null;

  async onload() {
    // 必须在 addSettingTab 之前初始化 iconManager，
    // 因为 addSettingTab 会立即调用 getSettingDefinitions() 做搜索索引
    // data.json 只读一次，图标数据和设置共用，避免重复磁盘读
    const stored = (await this.loadData()) as PluginData;
    const saveIcons = async (data: {
      icons: Icons;
      customIcons: Icons;
      customIconOrder: string[];
    }) => {
      const existing =
        ((await this.loadData()) as Record<string, unknown> | null) ?? {};
      await this.saveData(Object.assign({}, existing, data));
    };
    const loadIcons = async () =>
      Object.assign({}, stored) as
        | { icons?: Icons; customIcons?: Icons }
        | Icons;
    this.iconManager = new IconManager(saveIcons, loadIcons);
    // 布局未渲染完时跳过 DOM 扫描（图标还不在 DOM 里，布局渲染时会
    // 直接从注册表读取已替换的内容），运行中启用插件则照常扫描替换
    await this.iconManager.loadIcons({
      scanDom: this.app.workspace.layoutReady,
    });

    await this.loadSettings(stored);

    this.settingsTab = new IconSwapperSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    activeDocument.body.addClass("icon-swapper-enabled");
  }

  onunload() {
    // 取消未触发的防抖 reload，避免插件卸载后仍重启 Commander
    if (this.commanderReloadTimer !== null) {
      window.clearTimeout(this.commanderReloadTimer);
      this.commanderReloadTimer = null;
    }
    const safe = async (p: Promise<unknown>, label: string) => {
      try {
        await p;
      } catch (e) {
        console.error(`[IconSwapper] ${label} failed:`, e);
      }
    };
    void safe(this.iconManager.revertAll({ shouldSave: false }), "revertAll");
    void safe(this.iconManager.removeAllCustomIcons({ shouldSave: false }), "removeAllCustomIcons");
    activeDocument.body.removeClass("icon-swapper-enabled");
  }

  async loadSettings(stored?: PluginData) {
    const data = stored ?? ((await this.loadData()) as PluginData);
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      data?.settings ?? {}
    );
  }

  async saveSettings() {
    const existing =
      ((await this.loadData()) as Record<string, unknown> | null) ?? {};
    await this.saveData(Object.assign({}, existing, { settings: this.settings }));
  }

  async reloadCommander() {
    const commanderId = "cmdr";
    try {
      const plugins = (this.app as unknown as {
        plugins: {
          isEnabled: (id: string) => boolean;
          disablePlugin: (id: string) => Promise<void>;
          enablePlugin: (id: string) => Promise<void>;
        };
      }).plugins;
      if (!plugins || !plugins.isEnabled(commanderId)) {
        return;
      }
      await plugins.disablePlugin(commanderId);
      // 让出事件循环，确保 Commander 完全 unload 后再重新 load
      await new Promise((r) => window.setTimeout(r, 50));
      await plugins.enablePlugin(commanderId);
    } catch (e) {
      console.error("[IconSwapper] Failed to reload Commander:", e);
      new Notice(`Failed to reload Commander: ${e}`);
    }
  }

  // immediate: 添加图标后立即 reload（Commander 图标选择器马上可用）；
  // 默认防抖：合并连续删除/切换产生的多次触发
  async maybeReloadCommander(opts: { immediate?: boolean } = {}) {
    if (!this.settings.autoReloadCommander) return;
    if (this.commanderReloadTimer !== null) {
      window.clearTimeout(this.commanderReloadTimer);
      this.commanderReloadTimer = null;
    }
    if (opts.immediate) {
      await this.reloadCommander();
      return;
    }
    this.commanderReloadTimer = window.setTimeout(() => {
      this.commanderReloadTimer = null;
      void this.reloadCommander();
    }, COMMANDER_RELOAD_DEBOUNCE_MS);
  }
}

// ========== Modals ==========

class ExportModal extends Modal {
  plugin: IconSwapperPlugin;

  constructor(app: App, plugin: IconSwapperPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass("modal-icon-swapper");
    // yaml 库懒加载：只在打开导出弹窗时才求值，减少插件启动开销
    void this.renderContent();
  }

  private async renderContent() {
    const { stringify } = await import("yaml");
    const { contentEl } = this;

    const wrapIcons = (icons: { [k: string]: string }) =>
      Object.keys(icons).reduce<{ [k: string]: string }>((acc, name) => {
        acc[name] = `<svg viewBox="0 0 100 100">${icons[name]}</svg>`;
        return acc;
      }, {});

    const output = stringify({
      icons: wrapIcons(this.plugin.iconManager.icons),
      customIcons: wrapIcons(this.plugin.iconManager.customIcons),
      customIconOrder: this.plugin.iconManager.customIconOrder,
    });

    new Setting(contentEl)
      .setName("Export configuration")
      .then((setting) => {
        setting.controlEl.createEl("button", {
          cls: "icon-swapper-download",
        }, (el) => {
          setIcon(el, "download");
          el.appendText(" Download");
          el.addEventListener("click", () => {
            const a = createEl("a");
            a.download = "icons.yml";
            a.href = `data:text/yaml;charset=utf-8,${encodeURIComponent(output)}`;
            a.click();
          });
        });
      });

    new TextAreaComponent(contentEl)
      .setValue(output)
      .setDisabled(true)
      .then((ta) => ta.inputEl.addClass("iconify-config-textarea"));
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class ImportModal extends Modal {
  plugin: IconSwapperPlugin;

  constructor(app: App, plugin: IconSwapperPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    let { contentEl, modalEl } = this;
    modalEl.addClass("modal-icon-swapper");

    new Setting(contentEl)
      .setName("Import configuration")
      .setDesc("Warning: this will override any existing configuration")
      .then((setting) => {
        const fileInput = setting.controlEl.createEl(
          "input",
          {
            cls: "icon-swapper-import-input",
            attr: {
              id: "icon-swapper-import-input",
              name: "icon-swapper-import-input",
              type: "file",
              accept: ".yml",
            },
          },
          (importInput) => {
            importInput.addEventListener("change", (e) => {
              const reader = new FileReader();
              reader.onload = async (e: ProgressEvent<FileReader>) => {
                const result = e.target?.result;
                if (typeof result === "string") {
                  await importAndClose(result.trim());
                }
              };
              const files = (e.target as HTMLInputElement).files;
              if (files && files.length > 0) {
                reader.readAsText(files[0]);
              }
            });
          }
        );

        setting.controlEl.createEl("button", {
          cls: "icon-swapper-import-label",
        }, (el) => {
          setIcon(el, "file-up");
          el.appendText(" Import from file");
          el.addEventListener("click", () => fileInput.click());
        });
      });

    const importAndClose = async (str: string) => {
      if (str) {
        try {
          // yaml 库懒加载：只在导入配置时才求值
          const { parse } = await import("yaml");
          const parsed = parse(str) as Record<string, unknown>;
          const hasIconsKey = parsed && typeof parsed.icons === "object";
          const icons = (hasIconsKey ? parsed.icons : parsed) as Icons;
          const customIcons = (parsed?.customIcons || {}) as Icons;
          const customIconOrder = Array.isArray(parsed?.customIconOrder)
            ? (parsed.customIconOrder as string[])
            : undefined;

          await this.plugin.iconManager.revertAll({ shouldSave: false });
          await this.plugin.iconManager.removeAllCustomIcons();
          await this.plugin.iconManager.setAll(icons);
          await this.plugin.iconManager.setAllCustomIcons(customIcons, customIconOrder);
          this.plugin.settingsTab.update();
          this.close();
        } catch (e) {
          new Notice(`Error importing icon settings: ${e}`);
        }
      } else {
        new Notice("Error importing icon settings: config is empty");
      }
    };

    new TextAreaComponent(contentEl)
      .setPlaceholder("Or paste config here...")
      .then((ta) => {
        ta.inputEl.addClass("iconify-config-textarea");
        new ButtonComponent(contentEl)
          .setButtonText("Save")
          .onClick(async () => {
            await importAndClose(ta.getValue().trim());
          });
      });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

// ========== Custom Icon Modals ==========

class AddCustomIconModal extends Modal {
  plugin: IconSwapperPlugin;
  onSave: (name: string, svg: string) => Promise<void>;
  private currentSvg = "";
  private iconNameInput!: TextComponent;
  private previewEl!: HTMLDivElement;

  constructor(
    app: App,
    plugin: IconSwapperPlugin,
    onSave: (name: string, svg: string) => Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave;
  }

  onOpen() {
    let { contentEl, modalEl } = this;
    modalEl.addClass("modal-icon-swapper");

    contentEl.createEl("h2", { text: "Add custom icon" });

    // Icon Name
    new Setting(contentEl).setName("Icon name").addText((text) => {
      this.iconNameInput = text;
      text.setPlaceholder("E.g. My-icon").setValue("");
    });

    // SVG source — Upload
    const uploadSetting = new Setting(contentEl).setName("SVG source");
    const fileInput = uploadSetting.controlEl.createEl("input", {
      attr: { type: "file", accept: ".svg", style: "display: none;" },
    });
    uploadSetting.addButton((button) => {
      button.setButtonText("Upload SVG").onClick(() => fileInput.click());
    });
    fileInput.addEventListener("change", (event: Event) => {
      const files = (event.target as HTMLInputElement).files;
      const file = files && files.length > 0 ? files[0] : null;
      if (file && file.type === "image/svg+xml") {
        const reader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
          const raw = (e.target?.result as string) || "";
          const processed = processSvgContent(raw);
          this.currentSvg = processed;
          this.updatePreview();
          new Notice(`SVG file "${file.name}" loaded.`);
        };
        reader.readAsText(file);
      } else if (file) {
        new Notice("Please select a valid SVG file.");
      }
    });

    // SVG source — Paste
    contentEl.createDiv({
      text: "Or paste SVG",
      cls: "icon-swapper-svg-label",
    });
    new TextAreaComponent(contentEl)
      .setPlaceholder("<svg>...</svg>")
      .then((textarea) => {
        textarea.inputEl.addClass("icon-swapper-svg-textarea");
        textarea.onChange((value) => {
          const trimmed = value.trim();
          if (trimmed && validSvgRegEx.test(trimmed)) {
            const processed = processSvgContent(trimmed);
            this.currentSvg = processed;
          } else {
            this.currentSvg = trimmed;
          }
          this.updatePreview();
        });
      });

    // Preview
    contentEl.createEl("h3", { text: "Preview" });
    this.previewEl = contentEl.createDiv({ cls: "icon-swapper-preview" });
    this.updatePreview();

    // Buttons
    new Setting(contentEl).then((setting) => {
      setting.addButton((button) => {
        button
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const name = this.iconNameInput.getValue().trim();
            const svg = this.currentSvg.trim();

            if (!name) {
              new Notice("Please enter the icon name");
              return;
            }
            if (this.plugin.iconManager.customIcons[name]) {
              new Notice(
                `Icon name "${name}" already exist, please use other name.`
              );
              return;
            }
            if (!svg || !validSvgRegEx.test(svg)) {
              new Notice("Please input valid SVG content!");
              return;
            }

            await this.onSave(name, svg);
            this.close();
          });
      });
      setting.addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.close());
      });
      setting.nameEl.remove();
    });
  }

  private updatePreview() {
    if (!this.previewEl) return;
    this.previewEl.empty();
    if (this.currentSvg && validSvgRegEx.test(this.currentSvg)) {
      renderSvg(this.previewEl, this.currentSvg);
    } else if (this.currentSvg) {
      this.previewEl.setText("Invalid SVG");
      this.previewEl.addClass("icon-swapper-preview-error");
    } else {
      this.previewEl.setText("No SVG provided");
    }
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class UpdateCustomIconModal extends Modal {
  plugin: IconSwapperPlugin;
  iconName: string;
  onSave: (svg: string) => Promise<void>;
  private currentSvg = "";
  private previewEl!: HTMLDivElement;

  constructor(
    app: App,
    plugin: IconSwapperPlugin,
    iconName: string,
    onSave: (svg: string) => Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.iconName = iconName;
    this.onSave = onSave;
  }

  onOpen() {
    let { contentEl, modalEl } = this;
    modalEl.addClass("modal-icon-swapper");

    contentEl.createEl("h2", { text: `Update icon: ${this.iconName}` });

    // Current icon preview
    new Setting(contentEl).setName("Current icon").then((setting) => {
      setting.controlEl.createDiv({ cls: "icon-swapper-icon" }, (icon) => {
        try {
          setIcon(icon, this.iconName);
        } catch {
          icon.setText("?");
        }
      });
    });

    // SVG source — Upload
    const uploadSetting = new Setting(contentEl).setName("New SVG source");
    const fileInput = uploadSetting.controlEl.createEl("input", {
      attr: { type: "file", accept: ".svg", style: "display: none;" },
    });
    uploadSetting.addButton((button) => {
      button.setButtonText("Upload SVG").onClick(() => fileInput.click());
    });
    fileInput.addEventListener("change", (event: Event) => {
      const files = (event.target as HTMLInputElement).files;
      const file = files && files.length > 0 ? files[0] : null;
      if (file && file.type === "image/svg+xml") {
        const reader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
          const raw = (e.target?.result as string) || "";
          const processed = processSvgContent(raw);
          this.currentSvg = processed;
          this.updatePreview();
          new Notice(`SVG file "${file.name}" loaded.`);
        };
        reader.readAsText(file);
      } else if (file) {
        new Notice("Please select a valid SVG file.");
      }
    });

    // SVG source — Paste
    contentEl.createDiv({
      text: "Or paste SVG",
      cls: "icon-swapper-svg-label",
    });
    new TextAreaComponent(contentEl)
      .setPlaceholder("<svg>...</svg>")
      .then((textarea) => {
        textarea.inputEl.addClass("icon-swapper-svg-textarea");
        textarea.onChange((value) => {
          const trimmed = value.trim();
          if (trimmed && validSvgRegEx.test(trimmed)) {
            const processed = processSvgContent(trimmed);
            this.currentSvg = processed;
          } else {
            this.currentSvg = trimmed;
          }
          this.updatePreview();
        });
      });

    // Preview
    contentEl.createEl("h3", { text: "Preview" });
    this.previewEl = contentEl.createDiv({ cls: "icon-swapper-preview" });
    this.updatePreview();

    // Buttons
    new Setting(contentEl).then((setting) => {
      setting.addButton((button) => {
        button
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const svg = this.currentSvg.trim();
            if (!svg || !validSvgRegEx.test(svg)) {
              new Notice("Please input valid SVG content!");
              return;
            }
            await this.onSave(svg);
            this.close();
          });
      });
      setting.addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.close());
      });
      setting.nameEl.remove();
    });
  }

  private updatePreview() {
    if (!this.previewEl) return;
    this.previewEl.empty();
    if (this.currentSvg && validSvgRegEx.test(this.currentSvg)) {
      renderSvg(this.previewEl, this.currentSvg);
    } else if (this.currentSvg) {
      this.previewEl.setText("Invalid SVG");
      this.previewEl.addClass("icon-swapper-preview-error");
    } else {
      this.previewEl.setText("No SVG provided");
    }
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

// ========== Confirm Modal ==========

class ConfirmModal extends Modal {
  title: string;
  message: string;
  onConfirm: () => void;

  constructor(
    app: App,
    title: string,
    message: string,
    onConfirm: () => void
  ) {
    super(app);
    this.title = title;
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    let { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.message });

    new Setting(contentEl).then((setting) => {
      setting.addButton((button) => {
        button
          .setButtonText("Delete")
          .setDestructive()
          .onClick(() => {
            this.onConfirm();
            this.close();
          });
      });
      setting.addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.close());
      });
      setting.nameEl.remove();
    });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

// ========== Settings Tab ==========

class IconSwapperSettingsTab extends PluginSettingTab {
  icon: string = 'smile';
  plugin: IconSwapperPlugin;

  constructor(app: App, plugin: IconSwapperPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 框架默认会用 this.plugin.saveData(this.plugin.settings) 覆盖整个 data.json，
  // 这会丢失 icons / customIcons 数据。这里改用合并写入的 saveSettings()。
  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: value });
    await this.plugin.saveSettings();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      // Import/Export/Revert
      {
        name: "Import/Export",
        desc: "Import or export icon configuration",
        render: (setting) => {
          setting.controlEl.createEl(
            "button",
            { cls: "icon-swapper-import" },
            (el) => {
              setIcon(el, "download");
              el.appendText(" Import");
              el.addEventListener("click", () => {
                new ImportModal(this.app, this.plugin).open();
              });
            }
          );
          setting.controlEl.createEl(
            "button",
            { cls: "icon-swapper-export" },
            (el) => {
              setIcon(el, "upload");
              el.appendText(" Export");
              el.addEventListener("click", () => {
                new ExportModal(this.app, this.plugin).open();
              });
            }
          );
          setting.addExtraButton((b) => {
            b.setIcon("reset")
              .setTooltip("Restore default icons")
              .onClick(async () => {
                await this.plugin.iconManager.revertAll();
                this.update();
              });
          });
        },
      },

      // Custom Icon — list
      {
        type: "list",
        heading: "Custom icon",
        emptyState: "No custom icons added yet.",
        addItem: {
          name: "Add icon",
          action: () => {
            const modal = new AddCustomIconModal(
              this.app,
              this.plugin,
              async (name, svg) => {
                const success =
                  await this.plugin.iconManager.addCustomIcon(name, svg);
                if (success) {
                  new Notice(`Icon ${name} added.`);
                  await this.plugin.maybeReloadCommander({ immediate: true });
                } else {
                  new Notice("Failed to add icon.");
                }
              }
            );
            modal.onClose = () => {
              this.update();
            };
            modal.open();
          },
        },
        onDelete: (idx) => {
          const name = this.plugin.iconManager.customIconOrder[idx];
          if (name) {
            new ConfirmModal(
              this.app,
              "Delete icon",
              `Are you sure you want to delete the icon "${name}"?`,
              () => {
                void (async () => {
                  await this.plugin.iconManager.removeCustomIcon(name);
                  new Notice(`Icon ${name} deleted.`);
                  await this.plugin.maybeReloadCommander();
                  this.update();
                })();
              }
            ).open();
            // 恢复列表，等确认后再真正删除
            this.update();
          }
        },
        onReorder: (oldIndex, newIndex) => {
          void (async () => {
            await this.plugin.iconManager.reorderCustomIcons(oldIndex, newIndex);
            this.update();
          })();
        },
        items: this.plugin.iconManager.customIconOrder.map(
          (iconName) => ({
            name: iconName,
            searchable: false,
            render: (setting: Setting) => {
              const capturedName = iconName;
              setting.nameEl.empty();
              setting.nameEl.createDiv(
                { cls: "icon-swapper-container" },
                (container) => {
                  container.createDiv(
                    { cls: "icon-swapper-icon" },
                    (icon) => {
                      try {
                        setIcon(icon, capturedName);
                      } catch {
                        icon.setText("?");
                      }
                    }
                  );
                  container.createDiv(
                    { cls: "icon-swapper-name" },
                    (icoName) => {
                      icoName.setText(capturedName);
                    }
                  );
                }
              );

              setting.addButton((button) => {
                button
                  .setButtonText("Update")
                  .setTooltip("Update SVG")
                  .onClick(() => {
                    const modal = new UpdateCustomIconModal(
                      this.app,
                      this.plugin,
                      capturedName,
                      async (svg) => {
                        const success =
                          await this.plugin.iconManager.addCustomIcon(
                            capturedName,
                            svg
                          );
                        if (success) {
                          new Notice(`Icon ${capturedName} updated.`);
                        } else {
                          new Notice("Failed to update icon.");
                        }
                      }
                    );
                    modal.onClose = () => {
                      this.update();
                    };
                    modal.open();
                  });
              });
            },
          })
        ),
      },

      // Auto-reload Commander
      {
        name: "Auto-reload Commander",
        desc: "After adding or removing an icon, automatically restart the Commander plugin so its icon picker picks up the change. Commander caches the icon list when it loads, so newly added icons won't appear in its picker until Commander is restarted. Enabling this automates that restart.",
        control: {
          type: "toggle",
          key: "autoReloadCommander",
        },
      },

      // Default Icon 二级页面
      {
        type: "page",
        name: "Default icon",
        desc: "Replace Obsidian's built-in UI icons",
        page: () => new DefaultIconsPage(this.plugin),
      },
    ];
  }
}
