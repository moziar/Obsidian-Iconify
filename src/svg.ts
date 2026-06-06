import { INode } from "svgson";
import toPath from "element-to-path";
import {
  parse as pathParse,
  stringify as pathStringify,
  scale,
} from "svg-path-tools";
import { addIcon, setIcon } from "obsidian";

// Parse the viewbox attribute for the maximum value
// This is used to scale the svgs
export function getMaxViewBox(parsedSVG: INode) {
  const vb = parsedSVG.attributes.viewBox;
  if (!vb) {
    return 0;
  }
  return vb.split(" ").reduce((prev, c) => {
    const next = parseInt(c);
    if (prev > next) {
      return prev;
    }
    return next;
  }, 0);
}

// Scale a parsed SVG child element; adapted from https://github.com/elrumordelaluz/svg-path-tools
export function scalePath(
  node: INode,
  scaleOptions: { scale: number; round: number }
) {
  const o = Object.assign({}, node);
  const { scale: s } = scaleOptions || { scale: 1 };
  if (/(rect|circle|ellipse|polygon|polyline|line|path)/.test(o.name)) {
    const path = toPath(o);
    const parseD = pathParse(path);
    const scaleD = scale(parseD, scaleOptions);
    const d = pathStringify(scaleD);
    o.attributes = Object.assign({}, o.attributes, {
      d,
    });
    for (const attr in o.attributes) {
      if (attr === "stroke-width" || attr === "strokeWidth") {
        o.attributes[attr] = String(+o.attributes[attr] * s);
      }
      if (!/fill|stroke|opacity|d/.test(attr)) {
        delete o.attributes[attr];
      }
      // 不在这里设置 fill 属性，让 processSvgContent 函数处理
      else if (/stroke/.test(attr)) {
        o.attributes[attr] = "currentColor";
      }
    }
    // 不在这里设置 fill 属性，让 processSvgContent 函数处理
    if (
      !o.attributes.stroke &&
      (o.attributes.strokeWidth || o.attributes["stroke-width"])
    )
      o.attributes.stroke = "currentColor";
    o.name = "path";
  } else if (o.children && Array.isArray(o.children)) {
    const _scale = (c: any) => scalePath(c, scaleOptions);
    o.children = o.children.map(_scale);
  }
  return o;
}

// Retrieve the default SVG markup for a given icon name
export function getDefaultIconSVG(name: string) {
  const container = createDiv("div");
  setIcon(container, name);
  const inner = container.children[0].innerHTML;
  container.remove();
  return inner;
}

// Override a default icon's SVG markup
export function replaceIconSVG(name: string, content: string) {
  addIcon(name, content);
  // Replace any icons that already exist in the dom
  document.querySelectorAll(`svg.${name}`).forEach((el) => {
    el.innerHTML = content;
  });
}

// 智能处理SVG内容，区分不同层级的颜色
export function processSvgContent(svgContent: string): string {
  // 移除SVG中的fill属性，但保留层次感
  let processedSvg = svgContent;

  // 确保viewBox存在
  processedSvg = processedSvg.replace(/<svg[^>]*>/, function (match) {
    // 确保viewBox存在
    if (match.indexOf("viewBox") === -1) {
      // 如果没有viewBox，尝试从width和height创建一个
      const widthMatch = match.match(/width="([^"]*)"/);
      const heightMatch = match.match(/height="([^"]*)"/);
      if (widthMatch && heightMatch) {
        const width = widthMatch[1];
        const height = heightMatch[1];
        match = match.replace(/<svg/, `<svg viewBox="0 0 ${width} ${height}"`);
      }
    }
    return match;
  });

  // 保存 defs 部分，以便后续恢复
  let defsContent = "";
  const defsRegex = /<defs[^>]*>([\s\S]*?)<\/defs>/g;
  let defsMatch = defsRegex.exec(processedSvg);
  if (defsMatch) {
    defsContent = defsMatch[0];
    // 临时移除 defs 部分，以避免它被后续处理
    processedSvg = processedSvg.replace(defsMatch[0], "<!-- DEFS_PLACEHOLDER -->");
  }

  // 预处理：移除所有元素中的fill和fill-rule属性
  // 这样可以确保无论SVG中是否已经有fill属性，我们都能正确应用我们的颜色设置
  processedSvg = processedSvg.replace(
    /<(path|rect|circle|ellipse|line|polyline|polygon|g)[^>]*>/g,
    function (match) {
      // 移除所有形式的fill属性
      match = match.replace(/\s+fill\s*=\s*["'][^"']*["']/g, "");
      match = match.replace(/\s+fill\s*=\s*[^\s>\/>]*/g, "");
      // 移除所有形式的fill-rule属性
      match = match.replace(/\s+fill-rule\s*=\s*["'][^"']*["']/g, "");
      match = match.replace(/\s+fill-rule\s*=\s*[^\s>\/>]*/g, "");
      return match;
    }
  );

  // 解析SVG内容，处理路径元素
  const pathRegex = /<path[^>]*>/g;
  let pathMatches: { match: string; index: number }[] = [];

  // 首先收集所有路径元素
  let pathMatch;
  while ((pathMatch = pathRegex.exec(processedSvg)) !== null) {
    pathMatches.push({
      match: pathMatch[0],
      index: pathMatch.index,
    });
  }

  // 从后向前替换，以避免索引变化问题
  for (let i = pathMatches.length - 1; i >= 0; i--) {
    let match = pathMatches[i].match;
    let index = pathMatches[i].index;

    // 为第一层路径保留currentColor，为第二层路径使用透明色
    if (i === 0) {
      // 第一个路径使用currentColor
      match = match.replace(/<path/, '<path fill="currentColor"');
    } else {
      // 其他路径使用none
      match = match.replace(/<path/, '<path fill="var(--background-primary)"');
    }

    // 替换原始字符串中的路径
    processedSvg =
      processedSvg.substring(0, index) +
      match +
      processedSvg.substring(index + pathMatches[i].match.length);
  }

  // 同样处理其他可能的SVG元素
  const elementTypes = [
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "g",
  ];
  elementTypes.forEach((elementType) => {
    const regex = new RegExp(`<${elementType}[^>]*>`, "g");
    let elementMatches: { match: string; index: number }[] = [];
    let elementMatch;

    // 收集所有元素
    while ((elementMatch = regex.exec(processedSvg)) !== null) {
      elementMatches.push({
        match: elementMatch[0],
        index: elementMatch.index,
      });
    }

    // 从后向前替换
    for (let i = elementMatches.length - 1; i >= 0; i--) {
      let match = elementMatches[i].match;
      let index = elementMatches[i].index;

      // 为第一个元素使用currentColor，第二个使用背景色
      if (i === 0) {
        match = match.replace(
          new RegExp(`<${elementType}`),
          `<${elementType} fill="currentColor">`
        );
      } else {
        match = match.replace(
          new RegExp(`<${elementType}`),
          `<${elementType} fill="var(--background-primary)">`
        );
      }

      // 替换原始字符串中的元素
      processedSvg =
        processedSvg.substring(0, index) +
        match +
        processedSvg.substring(index + elementMatches[i].match.length);
    }
  });

  // 规范化空格
  processedSvg = processedSvg.trim();
  processedSvg = processedSvg.replace(/\s+/g, " ");
  processedSvg = processedSvg.replace(/\s*(<[^>]+>)\s*/g, "$1");

  // 恢复 defs 部分
  if (defsContent) {
    processedSvg = processedSvg.replace("<!-- DEFS_PLACEHOLDER -->", defsContent);
  }

  return processedSvg;
}
