import type { INode } from "svgson";
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
// 路径工具链（element-to-path / svg-path-tools）懒加载：
// 只有真正缩放用户提供的 SVG 时才求值，避免拖慢插件启动
export async function scalePath(
  node: INode,
  scaleOptions: { scale: number; round: number }
) {
  const [toPathMod, pathTools] = await Promise.all([
    import("element-to-path"),
    import("svg-path-tools"),
  ]);
  const toPath = toPathMod.default;
  const { parse: pathParse, stringify: pathStringify, scale } = pathTools;
  const s = scaleOptions?.scale ?? 1;

  const walk = (n: INode): INode => {
    const o = Object.assign({}, n);
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
      o.children = o.children.map(walk);
    }
    return o;
  };

  return walk(node);
}

// 复用 serializer/parser 实例，避免每次调用重复创建
const xmlSerializer = new XMLSerializer();
const domParser = new DOMParser();

// Retrieve the default SVG markup for a given icon name
export function getDefaultIconSVG(name: string) {
  const container = createDiv();
  setIcon(container, name);
  const svg = container.children[0];
  let inner = "";
  for (let i = 0; i < svg.childNodes.length; i++) {
    inner += xmlSerializer.serializeToString(svg.childNodes[i]);
  }
  container.remove();
  return inner;
}

// Override a default icon's SVG markup
export function replaceIconSVG(
  name: string,
  content: string,
  opts?: { scanDom?: boolean }
) {
  addIcon(name, content);
  // 允许跳过 DOM 扫描：插件启动时布局尚未渲染，图标还不在 DOM 里，
  // 布局渲染时会直接从注册表读取已替换的内容
  if (opts?.scanDom === false) return;
  const targets = activeDocument.querySelectorAll(`svg.${name}`);
  if (targets.length === 0) return;
  // 解析一次，克隆给每个目标元素，避免重复 parse
  const doc = domParser.parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`,
    "image/svg+xml"
  );
  const children = Array.from(doc.documentElement.childNodes);
  targets.forEach((el) => {
    el.replaceChildren(...children.map((c) => c.cloneNode(true)));
  });
}

// Safely render SVG string into an HTML element using DOMParser
export function renderSvg(el: HTMLElement, svgString: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, "image/svg+xml");
  el.replaceChildren();
  el.appendChild(doc.documentElement);
}

// 智能处理SVG内容，区分不同层级的颜色
// 使用 DOMParser 进行结构化处理，避免正则字符串操作的 edge case
export function processSvgContent(svgContent: string): string {
  const doc = domParser.parseFromString(svgContent, "image/svg+xml");

  // 解析失败时原样返回，避免破坏输入
  if (doc.querySelector("parsererror") || !doc.documentElement) {
    return svgContent;
  }

  const svg = doc.documentElement;

  // 确保viewBox存在：没有则尝试从width和height创建
  if (!svg.getAttribute("viewBox")) {
    const width = svg.getAttribute("width");
    const height = svg.getAttribute("height");
    if (width && height) {
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }
  }

  // 需要处理 fill 的形状/分组元素类型
  const SHAPE_TAGS = [
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "g",
  ];

  // 对每种类型：移除原有 fill / fill-rule，第一个元素使用 currentColor，
  // 其余元素使用 var(--background-primary)；跳过 <defs> 内部的元素以保留其原始定义
  SHAPE_TAGS.forEach((tag) => {
    const elements = Array.from(svg.getElementsByTagName(tag));
    const visibleElements = elements.filter((el) => !el.closest("defs"));
    visibleElements.forEach((el, i) => {
      el.removeAttribute("fill");
      el.removeAttribute("fill-rule");
      el.setAttribute(
        "fill",
        i === 0 ? "currentColor" : "var(--background-primary)"
      );
    });
  });

  return xmlSerializer.serializeToString(svg);
}
