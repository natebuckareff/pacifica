import solidDevtools from "solid-devtools/vite";
import type { PluginOption } from "vite";
import solidPlugin from "vite-plugin-solid";
import type { RouteConfigNode } from "../common/routes.js";

export interface PacificaPluginOptions {
  routes?: RouteConfigNode;
  pagesDir?: string;
}

export function pacificaPlugin(options?: PacificaPluginOptions): PluginOption {
  return [
    solidDevtools(),
    solidPlugin({ ssr: true }),
    pacificaCorePlugin(options),
  ];
}

function pacificaCorePlugin(_options?: PacificaPluginOptions): PluginOption {
  return {
    name: "pacifica-core",
    enforce: "pre",
  };
}
