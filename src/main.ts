import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinition,
  SettingDefinitionItem,
  TextAreaComponent,
  setIcon,
} from "obsidian";
import { parse, stringify } from "yaml";
import { createIconSetting } from "./createIconSetting";
import { DefaultIconsPage } from "./defaultIconsPage";
import { IconManager, Icons, validSvgRegEx } from "./iconManager";
import { processSvgContent } from "./svg";

export default class IconSwapperPlugin extends Plugin {
  settingsTab: IconSwapperSettingsTab;
  iconManager: IconManager;

  async onload() {
    // 必须在 addSettingTab 之前初始化 iconManager，
    // 因为 addSettingTab 会立即调用 getSettingDefinitions() 做搜索索引
    const saveIcons = async (data: { icons: Icons; customIcons: Icons }) =>
      await this.saveData(data);
    const loadIcons = async () => Object.assign({}, await this.loadData());
    this.iconManager = new IconManager(saveIcons, loadIcons);
    await this.iconManager.loadIcons();

    this.settingsTab = new IconSwapperSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    document.body.addClass("icon-swapper-enabled");
  }

  onunload() {
    this.iconManager.revertAll({ shouldSave: false });
    document.body.removeClass("icon-swapper-enabled");
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
    let { contentEl, modalEl } = this;
    modalEl.addClass("modal-icon-swapper");

    const wrapIcons = (icons: { [k: string]: string }) =>
      Object.keys(icons).reduce<{ [k: string]: string }>((acc, name) => {
        acc[name] = `<svg viewBox="0 0 100 100">${icons[name]}</svg>`;
        return acc;
      }, {});

    const output = stringify({
      icons: wrapIcons(this.plugin.iconManager.icons),
      customIcons: wrapIcons(this.plugin.iconManager.customIcons),
    });

    new Setting(contentEl)
      .setName("Export configuration")
      .then((setting) => {
        setting.controlEl.createEl(
          "button",
          { cls: "icon-swapper-copy" },
          (copyButton) => {
            setIcon(copyButton, "copy");
            copyButton.appendText(" Copy");
            copyButton.addEventListener("click", async () => {
              await navigator.clipboard.writeText(output);
              copyButton.addClass("success");
              setTimeout(() => {
                if (copyButton.parentNode) {
                  copyButton.removeClass("success");
                }
              }, 2000);
            });
          }
        );

        setting.controlEl.createEl("button", {
          cls: "icon-swapper-download",
        }, (el) => {
          setIcon(el, "download");
          el.appendText(" Download");
          el.addEventListener("click", () => {
            const a = document.createElement("a");
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
                if (result) {
                  await importAndClose(result.toString().trim());
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
          const parsed = parse(str);
          const hasIconsKey = parsed && typeof parsed.icons === "object";
          const icons = hasIconsKey ? parsed.icons : parsed;
          const customIcons = parsed?.customIcons || {};

          await this.plugin.iconManager.revertAll({ shouldSave: false });
          await this.plugin.iconManager.removeAllCustomIcons();
          await this.plugin.iconManager.setAll(icons);
          await this.plugin.iconManager.setAllCustomIcons(customIcons);
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
  private iconNameInput: any;
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
      text.setPlaceholder("e.g. my-icon").setValue("");
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
    new Setting(contentEl).setName("Or paste SVG").then((setting) => {
      new TextAreaComponent(contentEl)
        .setPlaceholder("<svg>...</svg>")
        .then((textarea) => {
          textarea.inputEl.style.width = "100%";
          textarea.inputEl.style.minHeight = "80px";
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
      setting.controlEl.remove();
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
      this.previewEl.innerHTML = this.currentSvg;
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
        } catch (e) {
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
    new Setting(contentEl).setName("Or paste SVG").then((setting) => {
      new TextAreaComponent(contentEl)
        .setPlaceholder("<svg>...</svg>")
        .then((textarea) => {
          textarea.inputEl.style.width = "100%";
          textarea.inputEl.style.minHeight = "80px";
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
      setting.controlEl.remove();
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
      this.previewEl.innerHTML = this.currentSvg;
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
          .setWarning()
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
  plugin: IconSwapperPlugin;

  constructor(app: App, plugin: IconSwapperPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      // Import/Export/Revert
      {
        name: "Import/Export",
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
                  this.update();
                } else {
                  new Notice("Failed to add icon.");
                }
              }
            );
            modal.open();
          },
        },
        onDelete: async (idx) => {
          const names = Object.keys(this.plugin.iconManager.customIcons);
          const name = names[idx];
          if (name) {
            new ConfirmModal(
              this.app,
              "Delete icon",
              `Are you sure you want to delete the icon "${name}"?`,
              async () => {
                await this.plugin.iconManager.removeCustomIcon(name);
                new Notice(`Icon ${name} deleted.`);
                this.update();
              }
            ).open();
            // 恢复列表，等确认后再真正删除
            this.update();
          }
        },
        onReorder: async (oldIndex, newIndex) => {
          const customIcons = this.plugin.iconManager.customIcons;
          const names = Object.keys(customIcons);
          const [moved] = names.splice(oldIndex, 1);
          names.splice(newIndex, 0, moved);
          // 重建对象以保持新顺序
          const reordered: Icons = {};
          for (const name of names) {
            reordered[name] = customIcons[name];
          }
          this.plugin.iconManager.customIcons = reordered;
          await this.plugin.iconManager.saveData();
          this.update();
        },
        items: Object.keys(this.plugin.iconManager.customIcons).map(
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
                      } catch (e) {
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
                          this.update();
                        } else {
                          new Notice("Failed to update icon.");
                        }
                      }
                    );
                    modal.open();
                  });
              });
            },
          })
        ) as SettingDefinition[],
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
