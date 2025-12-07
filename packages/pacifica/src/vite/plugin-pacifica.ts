import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import solidDevtools from "solid-devtools/vite";
import type { PluginOption, ResolvedConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { getRouteConfig, type RouteConfigNode } from "../common/routes.js";
import { exhaustive } from "../common/util.js";
import { readFileTree, type TreeDir } from "../server/file-tree.js";
import {
  getManifestRoutes,
  type ManifestRoute,
  type ManifestRouteIndex,
  type ManifestRoutePage,
} from "../server/manifest.js";

export interface PacificaPluginOptions {
  routes: RouteConfigNode | FilesystemRouting;
}

export interface FilesystemRouting {
  routesDir: string;
}

export function pacificaPlugin(options?: PacificaPluginOptions): PluginOption {
  return [
    solidDevtools(),
    solidPlugin({ ssr: true }),
    pacificaCorePlugin(options),
  ];
}

interface RouteState {
  fs?: {
    dir: string;
    tree: TreeDir;
  };
  routes: {
    config: RouteConfigNode;
    manifest: ManifestRoute;
  };
}

function pacificaCorePlugin(options?: PacificaPluginOptions): PluginOption {
  interface State {
    config: ResolvedConfig | undefined;
    routeState: RouteState | undefined;
  }

  const state: State = {
    config: undefined,
    routeState: undefined,
  };

  function getConfig() {
    if (!state.config) {
      throw Error("config not resolved");
    }
    return state.config;
  }

  async function getRouteState() {
    if (state.routeState) {
      return state.routeState;
    }
    const config = getConfig();
    state.routeState = await getRouteStateFromOptions(config, options);
    return state.routeState;
  }

  async function revalidateRoutes(filePath: string): Promise<void> {
    const routeState = await getRouteState();
    if (!routeState.fs) {
      return;
    }

    const resolvedPath = resolve(filePath);
    if (resolvedPath.startsWith(routeState.fs.dir)) {
      state.routeState = undefined;
    }
  }

  return {
    name: "pacifica-core",
    enforce: "pre",

    configResolved(resolvedConfig) {
      state.config = resolvedConfig;
    },

    configureServer(server) {
      server.watcher.on("add", async path => {
        await revalidateRoutes(path);
      });

      server.watcher.on("unlink", async path => {
        await revalidateRoutes(path);
      });

      server.middlewares.use(async (req, res, next) => {
        const parts = (req.url?.slice(1)?.split("/") ?? []).filter(Boolean);
        const segments = ["/", ...parts];
        const routes = (await getRouteState()).routes.manifest;
        const match = matchRoute(segments, routes);
        if (match) {
          const json = JSON.stringify(match, null, 2);
          const html = `<html><body><h1>match</h1><pre>${json}</pre></body></html>`;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
          return;
        }
        next();
      });
    },
  };
}

async function getRouteStateFromOptions(
  config: ResolvedConfig,
  options?: PacificaPluginOptions,
): Promise<RouteState> {
  if (options) {
    if ("routesDir" in options.routes) {
      const path = join(config.root, options.routes.routesDir);
      return getRouteStateFromPath(path);
    } else if ("path" in options.routes) {
      return {
        routes: {
          config: options.routes,
          manifest: getManifestRoutes(options.routes),
        },
      };
    } else {
      exhaustive(options.routes);
    }
  } else {
    const path = join(config.root, "src/routes");
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      throw Error("routes directory not found");
    }
    return getRouteStateFromPath(path);
  }
}

async function getRouteStateFromPath(path: string): Promise<RouteState> {
  const dir = resolve(path);
  const tree = await readFileTree(dir);
  const config = await getRouteConfig(tree);
  return {
    fs: { dir, tree },
    routes: {
      config,
      manifest: getManifestRoutes(config),
    },
  };
}

function matchRoute(
  segments: string[],
  routes: ManifestRoute,
): ManifestRoutePage | ManifestRouteIndex | undefined {
  if (segments.length === 0) {
    return;
  }

  if (routes.kind === "page") {
    if (segments.length !== 1) {
      return;
    }
    return routes.segment === segments[0] ? routes : undefined;
  } else if (routes.kind === "node") {
    const [seg, ...next] = segments;
    if (routes.segment !== seg) {
      return;
    }
    if (next.length === 0) {
      return routes.index;
    }
    for (const child of Object.values(routes.children ?? {})) {
      const match = matchRoute(next, child);
      if (match) {
        return match;
      }
    }
    return;
  } else if (routes.kind === "public") {
    throw Error("todo");
  } else if (routes.kind === "intercept") {
    throw Error("todo");
  } else {
    exhaustive(routes);
  }
}
