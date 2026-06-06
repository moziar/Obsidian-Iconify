import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TextAreaComponent,
  setIcon,
} from "obsidian";
import { parse, stringify } from "yaml";
import { icons } from "./icons";
import { createIconSetting } from "./createIconSetting";
import { IconManager, Icons, validSvgRegEx } from "./iconManager";
import { processSvgContent } from "./svg";

export default class IconSwapperPlugin extends Plugin {
  settingsTab: IconSwapperSettingsTab;
  iconManager: IconManager;

  async onload() {
    // Set up the settings tab
    this.settingsTab = new IconSwapperSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Set up the icon manager
    const saveIcons = async (data: { icons: Icons; customIcons: Icons }) =>
      await this.saveData(data);
    const loadIcons = async () => Object.assign({}, await this.loadData());
    this.iconManager = new IconManager(saveIcons, loadIcons);

    // Load any stored icons
    await this.iconManager.loadIcons();
    document.body.addClass("icon-swapper-enabled");
  }

  onunload() {
    // Revert all icons back to default, but don't save anything
    this.iconManager.revertAll({ shouldSave: false });
    document.body.removeClass("icon-swapper-enabled");
  }
}

class ExportModal extends Modal {
  plugin: IconSwapperPlugin;

  constructor(app: App, plugin: IconSwapperPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    let { contentEl, modalEl } = this;
    modalEl.addClass("modal-icon-swapper");

    new Setting(contentEl)
      .setName("Export icon configuration")
      .then((setting) => {
        // We only store the interior of the SVG in settings, so for safety and consistency,
        // we wrap the exported SVG with an svg tag set to the correct viewbox
        const wrappedIcons = Object.keys(
          this.plugin.iconManager.icons
        ).reduce<{ [k: string]: string }>((icons, currentIcon) => {
          icons[currentIcon] = `<svg viewBox="0 0 100 100">${this.plugin.iconManager.icons[currentIcon]}</svg>`;
          return icons;
        }, {});

        const output = stringify(wrappedIcons);

        // Build a copy to clipboard link
        setting.controlEl.createEl(
          "a",
          {
            cls: "icon-swapper-copy",
            text: "Copy to clipboard",
            href: "#",
          },
          (copyButton) => {
            new TextAreaComponent(contentEl)
              .setValue(output)
              .then((textarea) => {
                textarea.inputEl.setAttr("disabled", true);
                copyButton.addEventListener("click", (e) => {
                  e.preventDefault();
                  // Select the textarea contents and copy them to the clipboard
                  textarea.inputEl.select();
                  document.execCommand("copy");
                  copyButton.addClass("success");
                  setTimeout(() => {
                    // If the button is still in the dom, remove the success class
                    if (copyButton.parentNode) {
                      copyButton.removeClass("success");
                    }
                  }, 2000);
                });
              });
          }
        );

        // Build a download link
        setting.controlEl.createEl("a", {
          cls: "icon-swapper-download",
          text: "Download",
          attr: {
            download: "icons.yml",
            href: `data:text/yaml;charset=utf-8,${encodeURIComponent(output)}`,
          },
        });
      });
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
      .setName("Import icon configuration")
      .setDesc("Warning: this will override any existing icon configuration");

    new Setting(contentEl).then((setting) => {
      // Build an error message container
      const errorSpan = createSpan({
        cls: "icon-swapper-import-error",
        text: "Error importing config",
      });
      setting.nameEl.appendChild(errorSpan);

      // Attempt to parse the imported data and close if successful
      const importAndClose = async (str: string) => {
        if (str) {
          try {
            const importedSettings = parse(str);
            await this.plugin.iconManager.revertAll({ shouldSave: false });
            await this.plugin.iconManager.setAll(importedSettings);
            this.plugin.settingsTab.display();
            this.close();
          } catch (e) {
            errorSpan.addClass("active");
            errorSpan.setText(`Error importing icon settings: ${e}`);
          }
        } else {
          errorSpan.addClass("active");
          errorSpan.setText(`Error importing icon settings: config is empty`);
        }
      };

      // Build a file input
      setting.controlEl.createEl(
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
          // Set up a FileReader so we can parse the file contents
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

      // Build a label we will style as a link
      setting.controlEl.createEl("label", {
        cls: "icon-swapper-import-label",
        text: "Import from file",
        attr: {
          for: "icon-swapper-import-input",
        },
      });

      new TextAreaComponent(contentEl)
        .setPlaceholder("Paste config here...")
        .then((ta) => {
          new ButtonComponent(contentEl)
            .setButtonText("Save")
            .onClick(async () => {
              await importAndClose(ta.getValue().trim());
            });
        });
    });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class IconSwapperSettingsTab extends PluginSettingTab {
  plugin: IconSwapperPlugin;
  customIconsContainer!: HTMLDivElement;
  defaultIconsContainer!: HTMLDivElement;

  constructor(app: App, plugin: IconSwapperPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 只刷新自定义图标列表部分
  refreshCustomIcons() {
    if (!this.customIconsContainer) return;

    // 清空现有的自定义图标列表
    this.customIconsContainer.empty();

    // 重新创建自定义图标列表
    const customIcons = this.plugin.iconManager.customIcons;
    if (Object.keys(customIcons).length > 0) {
      this.customIconsContainer.createEl("h3", { text: "Current Icon" });

      for (const iconName in customIcons) {
        const iconSetting = new Setting(this.customIconsContainer);

        // 显示图标和名称
        iconSetting.nameEl.createDiv(
          { cls: "icon-swapper-container" },
          (container) => {
            container.createDiv({ cls: "icon-swapper-icon" }, (icon) => {
              try {
                setIcon(icon, iconName);
              } catch (e) {
                console.error(`Error setting icon ${iconName}:`, e);
                icon.setText("❌");
              }
            });
            container.createDiv(
              { cls: "icon-swapper-name" },
              (icoName) => {
                icoName.setText(iconName);
              }
            );
          }
        );

        // 为每个图标创建一个隐藏的文件输入元素
        const fileInput = iconSetting.controlEl.createEl("input", {
          attr: {
            type: "file",
            accept: ".svg",
            style: "display: none;",
          },
        });

        // 更新图标按钮
        iconSetting.addButton((button) => {
          button
            .setButtonText("Upload SVG")
            .setTooltip("Update this icon")
            .onClick(() => {
              fileInput.click();
            });
          // 添加CSS类名以应用特殊样式
          button.buttonEl.addClass("upload-svg-btn");
        });

        // 处理文件选择
        fileInput.addEventListener(
          "change",
          (event: Event) => {
            const files = (event.target as HTMLInputElement).files;
            const file = files && files.length > 0 ? files[0] : null;
            if (file && file.type === "image/svg+xml") {
              const reader = new FileReader();
              reader.onload = async (e: ProgressEvent<FileReader>) => {
                let svgContentProcessed = (e.target?.result as string) || "";
                // 智能处理SVG中的fill属性，以确保图标能正确显示在Image-mask中
                // 解析SVG内容，区分不同层级的路径
                svgContentProcessed = processSvgContent(svgContentProcessed);

                if (
                  svgContentProcessed &&
                  validSvgRegEx.test(svgContentProcessed)
                ) {
                  try {
                    // 更新图标
                    const success =
                      await this.plugin.iconManager.addCustomIcon(
                        iconName,
                        svgContentProcessed
                      );
                    if (success) {
                      new Notice(`Icon ${iconName} has been updated.`);
                      this.refreshCustomIcons(); // 刷新自定义图标部分
                    } else {
                      new Notice("Failed to update icon.");
                    }
                  } catch (error) {
                    console.error("Error updating custom icon:", error);
                    new Notice("Error updating custom icon.");
                  }
                } else {
                  new Notice("Please select a valid SVG file.");
                }
              };
              reader.readAsText(file);
            } else if (file) {
              new Notice("Please select a valid SVG file.");
            }
          }
        );

        // 删除按钮
        iconSetting.addButton((button) => {
          button
            .setIcon("trash")
            .setTooltip("Delete this icon")
            .onClick(async () => {
              await this.plugin.iconManager.removeCustomIcon(iconName);
              new Notice(`Icon ${iconName} has been deleted.`);
              this.refreshCustomIcons(); // 只刷新自定义图标部分
            });
          button.buttonEl.addClass("delete-svg-btn");
        });
      }
    }
  }

  display(): void {
    let { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("icon-swapper");

    // 顶部操作按钮
    new Setting(containerEl)
      .then((setting) => {
        // Build and import link to open the import modal
        setting.controlEl.createEl(
          "a",
          {
            cls: "icon-swapper-import",
            text: "Import",
            href: "#",
          },
          (el) => {
            el.addEventListener("click", (e) => {
              e.preventDefault();
              new ImportModal(this.app, this.plugin).open();
            });
          }
        );
        // Build and export link to open the export modal
        setting.controlEl.createEl(
          "a",
          {
            cls: "icon-swapper-export",
            text: "Export",
            href: "#",
          },
          (el) => {
            el.addEventListener("click", (e) => {
              e.preventDefault();
              new ExportModal(this.app, this.plugin).open();
            });
          }
        );
      })
      // Build a revert link
      .addExtraButton((b) => {
        b.setIcon("reset")
          .setTooltip("Restore default icons")
          .onClick(async () => {
            await this.plugin.iconManager.revertAll();
            // Rebuild settings pane after the changes have been made
            this.display();
          });
      });

    // 自定义图标部分
    containerEl.createEl("h3", { text: "Custom Icon" });

    // 添加自定义图标的表单
    const customIconFormContainer = containerEl.createDiv({
      cls: "custom-icon-form-container",
    });

    const addIconSetting = new Setting(customIconFormContainer).setName(
      "Add new customize icon"
    );

    // 图标名称输入框
    let iconNameInput: any;
    addIconSetting.addText((text) => {
      iconNameInput = text;
      text.setPlaceholder("icon name").setValue("");
    });

    // SVG上传按钮替换原来的文本区域
    let svgContent = "";

    // 创建一个隐藏的文件输入元素
    const fileInput = addIconSetting.controlEl.createEl("input", {
      attr: {
        type: "file",
        accept: ".svg",
        style: "display: none;",
      },
    });

    // 创建上传按钮
    addIconSetting.addButton((button) => {
      button
        .setButtonText("Upload SVG")
        .setCta()
        .onClick(() => {
          fileInput.click();
        });
      // 添加CSS类名以应用特殊样式
      button.buttonEl.addClass("upload-svg-btn");
    });

    // 处理文件选择
    fileInput.addEventListener("change", (event: Event) => {
      const files = (event.target as HTMLInputElement).files;
      const file = files && files.length > 0 ? files[0] : null;
      if (file && file.type === "image/svg+xml") {
        const reader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
          let svgContentProcessed = (e.target?.result as string) || "";
          // 智能处理SVG中的fill属性，以确保图标能正确显示在Image-mask中
          // 解析SVG内容，区分不同层级的路径
          svgContentProcessed = processSvgContent(svgContentProcessed);

          svgContent = svgContentProcessed;
          new Notice(`SVG file "${file.name}" loaded successfully.`);
        };
        reader.readAsText(file);
      } else if (file) {
        new Notice("Please select a valid SVG file.");
        svgContent = "";
      }
    });

    // 添加按钮
    addIconSetting.addButton((button) => {
      button
        .setButtonText("Add")
        .setCta()
        .onClick(async () => {
          const name = iconNameInput.getValue().trim();
          const svg = svgContent.trim();

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
            new Notice("Please input valid svg content!");
            return;
          }

          try {
            const success = await this.plugin.iconManager.addCustomIcon(
              name,
              svg
            );
            if (success) {
              new Notice(`Icon ${name} successful added.`);
              iconNameInput.setValue("");
              svgContent = ""; // 清空SVG内容
              // 重置文件输入元素
              (fileInput as HTMLInputElement).value = "";
              this.refreshCustomIcons(); // 只刷新自定义图标部分
            } else {
              new Notice("Add custom icon fail.");
            }
          } catch (error) {
            console.error("Error adding custom icon:", error);
            new Notice("Error adding custom icon.");
          }
        });
    });

    // 创建自定义图标列表容器
    this.customIconsContainer = containerEl.createDiv({
      cls: "custom-icons-list-container",
    });

    // 初始化自定义图标列表
    this.refreshCustomIcons();

    // 默认图标替换部分 - 创建独立容器
    const defaultIconsSection = containerEl.createDiv({
      cls: "default-icons-section",
    });
    defaultIconsSection.createEl("h3", { text: "Default Icon" });
    this.defaultIconsContainer = defaultIconsSection.createDiv({
      cls: "default-icons-container",
    });

    // Build a setting for each icon
    try {
      icons.forEach((name) => {
        createIconSetting({
          containerEl: this.defaultIconsContainer,
          name,
          iconManager: this.plugin.iconManager,
        });
      });
    } catch (error) {
      console.error("Error creating default icon settings:", error);
      this.defaultIconsContainer.createEl("p", {
        text: "Error creating default icon settings.",
      });
    }
  }
}
