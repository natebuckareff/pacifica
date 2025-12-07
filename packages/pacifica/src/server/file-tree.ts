import fs from "node:fs/promises";
import path from "node:path";

export interface TreeDir {
  kind: "dir";
  filename: string;
  src: string;
  children: FileTree[];
}

export interface TreeFile {
  kind: "file";
  filename: string;
  src: string;
}

export type FileTree = TreeDir | TreeFile;

export async function readFileTree(dirPath: string): Promise<TreeDir> {
  const rootPath = path.resolve(dirPath);

  if (!(await fs.stat(rootPath)).isDirectory()) {
    throw Error("not a directory");
  }

  async function walkDir(srcPath: string): Promise<TreeDir> {
    const filename = path.basename(srcPath);
    const src = path.relative(rootPath, srcPath);
    const files = await fs.readdir(srcPath);
    const children: FileTree[] = [];
    for (const child of files) {
      const entry = await walk(path.join(srcPath, child));
      children.push(entry);
    }
    return { kind: "dir", filename, src, children };
  }

  async function walkFile(srcPath: string): Promise<Omit<TreeFile, "mtime">> {
    const filename = path.basename(srcPath);
    const src = path.relative(rootPath, srcPath);
    return { kind: "file", filename, src };
  }

  async function walk(srcPath: string): Promise<FileTree> {
    const stat = await fs.stat(srcPath);
    if (stat.isDirectory()) {
      return walkDir(srcPath);
    } else {
      return walkFile(srcPath);
    }
  }

  return walkDir(rootPath);
}
