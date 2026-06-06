import { INode, parse, stringify } from "svgson";
import { addIcon } from "obsidian";
import {
  getDefaultIconSVG,
  getMaxViewBox,
  replaceIconSVG,
  scalePath,
} from "./svg";

export const validSvgRegEx = /^<svg[^>]+?>[\s\S]*?<\/svg>?/i;

// Convert a user-supplied SVG to the correct format and size for addIcon
export async function svgToIcon(value: string) {
  try {
    const parsed = await parse(value);
    const maxViewBox = getMaxViewBox(parsed);
    const children: string[] = [];
    if (maxViewBox) {
      parsed.children.forEach((path: INode) => {
        children.push(
          stringify(
            // Scale the SVG to 100x100 only if the viewbox isn't already at 100
            maxViewBox === 100
              ? path
              : scalePath(path, { scale: 100 / maxViewBox, round: 3 })
          )
        );
      });
    }
    return children.join("");
  } catch (e) {
    console.error("Error parsing SVG:", e);
  }
}

export interface Icons {
  [k: string]: string;
}

type SaveFn = (icons: { icons: Icons; customIcons: Icons }) => Promise<void>;
type LoadFn = () => Promise<{ icons?: Icons; customIcons?: Icons } | Icons>;

export class IconManager {
  defaults: Icons;
  icons: Icons;
  customIcons: Icons;
  save: SaveFn;
  load: LoadFn;

  constructor(save: SaveFn, load: LoadFn) {
    this.defaults = {};
    this.icons = {};
    this.customIcons = {};
    this.save = save;
    this.load = load;
  }

  async loadIcons() {
    const data = await this.load();
    const hasIconsKey = data && typeof (data as Record<string, unknown>).icons === "object";
    const icons: Icons = hasIconsKey ? (data as { icons: Icons }).icons : (data as Icons) || {};
    const customIcons: Icons = hasIconsKey && (data as Record<string, unknown>).customIcons
      ? (data as { customIcons: Icons }).customIcons
      : {};

    // 加载默认图标替换
    for (const icon in icons) {
      await this.setIcon({
        name: icon,
        svg: icons[icon],
        shouldSave: false,
        isTrustedSource: true,
      });
    }

    // 加载自定义图标
    this.customIcons = customIcons;
    for (const icon in customIcons) {
      addIcon(icon, customIcons[icon]);
    }
  }

  async setIcon(opts: {
    name: string;
    svg: string;
    shouldSave?: boolean;
    isTrustedSource?: boolean;
  }) {
    const { name, svg, shouldSave = true, isTrustedSource = false } = opts;
    // Store a copy of the default icon if we haven't already
    if (!this.defaults[name]) {
      this.defaults[name] = getDefaultIconSVG(name);
    }
    const iconSVG = isTrustedSource ? svg : (await svgToIcon(svg)) || "";
    replaceIconSVG(name, iconSVG);
    this.icons[name] = iconSVG;
    if (shouldSave) {
      await this.saveData();
    }
  }

  // 保存所有数据（包括默认图标替换和自定义图标）
  async saveData() {
    await this.save({
      icons: this.icons,
      customIcons: this.customIcons,
    });
  }

  // 添加自定义图标
  async addCustomIcon(name: string, svg: string) {
    if (!name || !svg) return false;

    try {
      const iconSVG = (await svgToIcon(svg)) || "";
      addIcon(name, iconSVG);
      this.customIcons[name] = iconSVG;
      await this.saveData();
      return true;
    } catch (e) {
      console.error("Error adding custom icon:", e);
      return false;
    }
  }

  // 删除自定义图标
  async removeCustomIcon(name: string) {
    if (this.customIcons[name]) {
      delete this.customIcons[name];
      await this.saveData();
      return true;
    }
    return false;
  }

  // 删除所有自定义图标
  async removeAllCustomIcons() {
    this.customIcons = {};
    await this.saveData();
  }

  // 批量导入自定义图标
  async setAllCustomIcons(icons: Icons) {
    for (const name in icons) {
      const svg = (icons[name] || "").trim();
      if (!svg || !validSvgRegEx.test(svg)) continue;
      const iconSVG = (await svgToIcon(svg)) || "";
      addIcon(name, iconSVG);
      this.customIcons[name] = iconSVG;
    }
    await this.saveData();
  }

  async setAll(icons: Icons) {
    for (const icon in icons) {
      const svg = (icons[icon] || "").trim();
      // Try to validate the SVG string as best we can
      if (!svg) continue;
      if (!validSvgRegEx.test(svg)) continue;
      await this.setIcon({ name: icon, svg, shouldSave: false });
    }
    await this.saveData();
  }

  async revertIcon(opts: { name: string; shouldSave?: boolean }) {
    const { name, shouldSave = true } = opts;
    // Replace the supplied icon with the default
    if (this.icons[name]) {
      replaceIconSVG(name, this.defaults[name]);
      delete this.icons[name];
    }
    if (shouldSave) {
      await this.saveData();
    }
  }

  async revertAll(opts: { shouldSave?: boolean } = {}) {
    const { shouldSave = true } = opts;
    for (const icon in this.icons) {
      await this.revertIcon({ name: icon, shouldSave: false });
    }
    if (shouldSave) {
      await this.saveData();
    }
  }
}
