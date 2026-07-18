declare module "element-to-path" {
  interface ElementLike {
    name: string;
    attributes: { [key: string]: string };
    children?: ElementLike[];
    value?: string;
  }
  export default function toPath(el: ElementLike): string;
}

declare module "svg-path-tools" {
  export interface PathData {
    [key: string]: unknown;
  }
  export function parse(path: string): PathData;
  export function stringify(path: PathData): string;
  export function scale(
    path: PathData,
    options: { scale: number; round: number }
  ): PathData;
}
