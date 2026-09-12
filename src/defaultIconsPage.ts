import { SettingPage } from "obsidian";
import { icons } from "./icons";
import { createIconSetting } from "./createIconSetting";
import type IconifyPlugin from "./main";

export class DefaultIconsPage extends SettingPage {
  plugin: IconifyPlugin;

  constructor(plugin: IconifyPlugin) {
    super();
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.addClass("iconify");

    try {
      icons.forEach((name) => {
        createIconSetting({
          containerEl: this.containerEl,
          name,
          iconManager: this.plugin.iconManager,
          onIconChange: () => this.plugin.maybeReloadCommander(),
        });
      });
    } catch (error) {
      console.error("Error creating default icon settings:", error);
      this.containerEl.createEl("p", {
        text: "Error creating default icon settings.",
      });
    }
  }

  hide(): void {
    // 无需特殊清理
  }
}
