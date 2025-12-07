import { exhaustive } from "../common/util.js";
import type { FileTree, TreeDir } from "../server/file-tree.js";
import { readFileTree } from "../server/file-tree.js";

export type RouteConfig = RouteConfigNode | RouteConfigPage;

export interface RouteConfigNode {
  intercept?: RouteConfigInterceptType;
  path: string;
  param?: string;
  layout?: string;
  scripts?: string[];
  children: RouteConfig[];
}

export interface RouteConfigPage {
  intercept?: RouteConfigInterceptType;
  path: string;
  param?: string;
  file: string;
}

export type RouteConfigInterceptType = "." | ".." | "../.." | "...";

type ParsedRouteName =
  | ParsedSegmentName
  | { kind: "group"; name: string; tree: FileTree }
  | { kind: "slot"; name: string; tree: FileTree }
  | { kind: "fallback"; name: string; tree: FileTree };

type RouteConfigParamType = "required" | "optional" | "catch-all";

interface ParsedSegmentName {
  kind: "segment";
  name: string;
  param?: RouteConfigParamType;
  intercept?: RouteConfigInterceptType;
  tree: FileTree;
  extension?: string;
}

interface RouteConfigParam {
  type: RouteConfigParamType;
  name: string;
}

const SEGMENT_REGEX = /^([^.()]+)(\..*)?$/;
const ESCAPED_REGEX = /^([^()]+)\(([^)]+)\)(\..*)?$/;
const GROUP_REGEX = /^\(([^.]+)\)(\..*)?$/;
const SLOT_REGEX = /^@([^.]+)(\..*)?$/;
const FALLBACK_REGEX = /^\*([^.]+)(\..*)?$/;
const OPTIONAL_PARAM_REGEX = /^\[\[([^.]+)\]\](\..*)?$/;
const REQUIRED_PARAM_REGEX = /^\[([^.]+)\](\..*)?$/;
const CATCH_ALL_REGEX = /^\[\.\.\.([^.]+)\](\..*)?$/;
const INTERCEPT_REGEX =
  /^(\(\.\)|\(\.\.\)|\(\.\.\)\(\.\.\)|\(\.\.\.\))([^()]+)$/;

export function isRouteConfigNode(
  config: RouteConfig,
): config is RouteConfigNode {
  return "children" in config;
}

export function isRouteConfigPage(
  config: RouteConfig,
): config is RouteConfigPage {
  return "file" in config;
}

export async function readRouteConfig(
  dirPath: string,
): Promise<RouteConfigNode> {
  const tree = await readFileTree(dirPath);
  return getRouteConfig(tree);
}

export async function getRouteConfig(tree: TreeDir): Promise<RouteConfigNode> {
  return getRouteConfigFromDirTree(tree, undefined, true);
}

function getRouteConfigFromFileTree(
  tree: FileTree,
  routeName?: ParsedRouteName,
): RouteConfig {
  routeName ??= parseRouteName(tree);

  if (routeName.tree.kind === "file") {
    const path = getRoutePath(routeName);
    if (!path) {
      // fails for groups and index aliases, which are handled when parsing
      // directories
      throw Error("invalid route path");
    }

    const intercept =
      routeName.kind === "segment" ? routeName.intercept : undefined;

    return {
      intercept,
      path,
      param: getParamName(routeName),
      file: tree.src,
    };
  } else if (routeName.tree.kind === "dir") {
    return getRouteConfigFromDirTree(routeName.tree, routeName, false);
  } else {
    exhaustive(routeName.tree);
  }
}

function getRouteConfigFromDirTree(
  tree: TreeDir,
  routeName: ParsedRouteName | undefined,
  isRoot: boolean,
): RouteConfigNode {
  routeName ??= parseRouteName(tree);

  // find the index route for segment dirs
  let indexTree: FileTree | undefined;
  if (routeName.kind === "segment") {
    for (const child of tree.children) {
      if (isIndex(child)) {
        if (indexTree) {
          throw Error("multiple index routes");
        }
        indexTree = child;
      }
    }
  }

  let layout: string | undefined;
  let scripts: string[] | undefined;

  const children: RouteConfig[] = [];

  if (indexTree) {
    children.push({
      path: "/",
      file: indexTree.src,
    } satisfies RouteConfigPage);
  }

  // parse the children, skipping the index
  for (const child of tree.children) {
    if (indexTree?.filename === child.filename) {
      continue;
    }

    if (isLayout(child)) {
      if (layout) {
        throw Error("multiple layouts");
      }
      layout = child.src;
      continue;
    }

    if (isScript(child)) {
      scripts ??= [];
      scripts.push(child.src);
    }

    // need to recursive into any child group directories and collapse them so
    // they're under the same route
    const childRouteName = parseRouteName(child);
    const collapsedChildren = [...getCollapsedGroups(child, childRouteName)];

    children.push(
      ...collapsedChildren.map(({ tree, routeName }) =>
        getRouteConfigFromFileTree(tree, routeName),
      ),
    );
  }

  const path = isRoot ? "/" : getRoutePath(routeName);

  if (!path) {
    throw Error("invalid route path");
  }

  if (routeName.kind === "segment") {
    return {
      intercept: routeName.intercept,
      path,
      param: getParamName(routeName),
      layout,
      scripts,
      children,
    } satisfies RouteConfigNode;
  } else if (routeName.kind === "group") {
    // all directory groups are collapsed before this
    throw Error("unexpected group");
  } else if (routeName.kind === "slot") {
    return {
      path,
      layout,
      children,
    } satisfies RouteConfigNode;
  } else if (routeName.kind === "fallback") {
    throw Error("fallback routes must not be directories");
  } else {
    exhaustive(routeName);
  }
}

function* getCollapsedGroups(
  tree: FileTree,
  routeName: ParsedRouteName,
): Iterable<{ tree: FileTree; routeName: ParsedRouteName }> {
  if (tree.kind !== "dir" || routeName.kind !== "group") {
    yield { tree, routeName };
    return;
  }

  for (const child of tree.children) {
    const childRouteName = parseRouteName(child);
    yield* getCollapsedGroups(child, childRouteName);
  }
}

function isIndex(child: FileTree): boolean {
  if (child.kind === "dir") {
    return false;
  }

  if (isLayout(child)) {
    return false;
  }

  const childRouteName = parseRouteName(child);

  if (childRouteName.kind === "segment") {
    if (childRouteName.name === "index") {
      return true;
    }
  } else if (childRouteName.kind === "group") {
    return true;
  }

  return false;
}

function isLayout(tree: FileTree): boolean {
  return (
    tree.kind === "file" &&
    tree.filename.startsWith("_") &&
    !tree.filename.startsWith("__")
  );
}

function isScript(tree: FileTree): boolean {
  return (
    tree.kind === "file" &&
    (tree.filename.endsWith(".script.ts") ||
      tree.filename.endsWith(".script.tsx"))
  );
}

function getParamName(routeName: ParsedRouteName): string | undefined {
  return routeName.kind === "segment" && routeName.param
    ? routeName.name
    : undefined;
}

function getSegmentPath(routeName: ParsedSegmentName): string {
  const { name, param } = routeName;
  if (param) {
    if (param === "required") {
      return `/:${name}`;
    } else if (param === "optional") {
      return `/:${name}?`;
    } else if (param === "catch-all") {
      return `/*${name}`;
    } else {
      exhaustive(param);
    }
  }
  return `/${name}`;
}

function getRoutePath(routeName: ParsedRouteName): string | undefined {
  if (routeName.kind === "segment") {
    return getSegmentPath(routeName);
  } else if (routeName.kind === "group") {
    return;
  } else if (routeName.kind === "slot") {
    return `/@${routeName.name}`;
  } else if (routeName.kind === "fallback") {
    return `/^${routeName.name}`;
  } else {
    exhaustive(routeName);
  }
}

function parseRouteName(tree: FileTree): ParsedRouteName {
  if (isLayout(tree)) {
    throw Error("unexpected layout");
  }

  const groupName = parseGroupName(tree.filename);
  if (groupName) {
    return {
      kind: "group",
      name: groupName,
      tree,
    };
  }

  const slotName = parseSlotName(tree.filename);
  if (slotName) {
    return {
      kind: "slot",
      name: slotName,
      tree,
    };
  }

  const fallbackName = parseFallbackName(tree.filename);
  if (fallbackName) {
    return {
      kind: "fallback",
      name: fallbackName,
      tree,
    };
  }

  const intercept = parseIntercept(tree.filename);
  const filename = intercept?.filename ?? tree.filename;

  const param = parseParam(filename);
  const escaped = parseEscapedRoute(filename);
  const segmentName = parseSegmentName(filename);
  const extension = segmentName?.extension;

  const name = param ? param.name : (escaped?.segment ?? segmentName?.name);

  if (!name) {
    throw Error(`invalid segment name: ${filename}`);
  }

  return {
    kind: "segment",
    name: name,
    param: param?.type,
    intercept: intercept?.type,
    tree,
    extension,
  };
}

function parseSegmentName(
  filename: string,
): { name: string; extension: string } | undefined {
  const match = filename.match(SEGMENT_REGEX);
  if (match) {
    const name = match[1]!;
    const extension = match[2]!;
    return { name, extension };
  }
}

function parseEscapedRoute(
  filename: string,
): { segment: string; group: string } | undefined {
  const match = filename.match(ESCAPED_REGEX);
  if (match) {
    return {
      segment: match[1]!,
      group: match[2]!,
    };
  }
}

function parseGroupName(filename: string): string | undefined {
  const match = filename.match(GROUP_REGEX);
  if (match) {
    return match[1]!;
  }
}

function parseSlotName(filename: string): string | undefined {
  const match = filename.match(SLOT_REGEX);
  if (match) {
    return match[1]!;
  }
}

function parseFallbackName(filename: string): string | undefined {
  const match = filename.match(FALLBACK_REGEX);
  if (match) {
    return match[1]!;
  }
}

function parseParam(filename: string): RouteConfigParam | undefined {
  return (
    parseOptionalParamName(filename) ??
    parseRequiredParamName(filename) ??
    parseCatchAllParamName(filename)
  );
}

function parseOptionalParamName(
  filename: string,
): RouteConfigParam | undefined {
  const match = filename.match(OPTIONAL_PARAM_REGEX);
  if (match) {
    return {
      type: "optional",
      name: match[1]!,
    };
  }
}

function parseRequiredParamName(
  filename: string,
): RouteConfigParam | undefined {
  const match = filename.match(REQUIRED_PARAM_REGEX);
  if (match) {
    return {
      type: "required",
      name: match[1]!,
    };
  }
}

function parseCatchAllParamName(
  filename: string,
): RouteConfigParam | undefined {
  const match = filename.match(CATCH_ALL_REGEX);
  if (match) {
    return {
      type: "catch-all",
      name: match[1]!,
    };
  }
}

function parseIntercept(
  filename: string,
): { type: RouteConfigInterceptType; filename: string } | undefined {
  const match = filename.match(INTERCEPT_REGEX);
  if (match) {
    return {
      type: parseInterceptType(match[1]!),
      filename: match[2]!,
    };
  }
}

function parseInterceptType(type: string): RouteConfigInterceptType {
  switch (type) {
    case "(.)":
      return ".";

    case "(..)":
      return "..";

    case "(..)(..)":
      return "../..";

    case "(...)":
      return "...";

    default:
      throw Error(`invalid intercept type: ${type}`);
  }
}
