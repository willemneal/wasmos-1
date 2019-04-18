import { glob, fs, mkdirp, assemblyFolders } from "@wasmos/fs/src";
import * as asc from "assemblyscript/cli/asc";

import * as path from "path";
import assert = require("assert");

let join = path.join;

interface CompilerOptions {
  /** Standard output stream to use. */
  stdout?: asc.OutputStream;
  /** Standard error stream to use. */
  stderr?: asc.OutputStream;
  /** Reads a file from disk (or memory). */
  readFile?: (filename: string, baseDir: string) => Promise<string | null>;
  /** Writes a file to disk (or memory). */
  writeFile?: (
    filename: string,
    contents: Uint8Array,
    baseDir: string
  ) => Promise<void>;
  /** Lists all files within a directory. */
  listFiles?: (dirname: string, baseDir: string) => Promise<string[] | null>;
  /** Output Directory */
  outDir?: string;
  /** Base directory for assembly source */
  baseDir?: string;
  /** Command line args passed to asc */
  cmdline?: string[];
  /**  Whether to print mesaurements */
  mesaure?: boolean;
  /** Whether to include all assembly library folders */
  lib?: boolean;
}

function isRoot(dir: string): boolean {
  return path.basename(dir) !== "";
}

export async function linkLibrary(rootPath: string): Promise<string> {
  let folders = await assemblyFolders(rootPath);
  let assemblyFolder = path.join(rootPath, "node_modules", ".assembly");
  await mkdirp(assemblyFolder);
  let pwd = process.cwd();
  process.chdir(assemblyFolder);
  await Promise.all(
    folders.map(async (v: string) => {
      let folder = path.dirname(v);
      let grandFolder = path.dirname(folder);
      folder = path.basename(folder);
      while (path.basename(grandFolder) != "node_modules") {
        folder = path.join(path.basename(grandFolder), folder);
        grandFolder = path.dirname(grandFolder);
      }
      if (path.basename(path.dirname(folder)) != "node_modules") {
        await mkdirp(path.dirname(folder));
      }
      let folderExists = await fs.pathExists(folder);
      if (!folderExists) {
        let realPath = await fs.realpath(v);
        await fs.symlink(realPath, folder, "dir");
      }
    })
  );
  process.chdir(pwd);

  return assemblyFolder;
}

export class Compiler {
  static get opts(): CompilerOptions {
    return Compiler._opts;
  }
  static mergeOpts(newOpts?: CompilerOptions): CompilerOptions {
    if (newOpts) this._opts = { ...newOpts, ...this._opts };
    return this._opts;
  }

  private static _opts = {
    readFile: async (basename: string, baseDir: string) => {
      let base = baseDir ? baseDir : ".";
      console.log(basename);
      try {
        let file = path.join(base, basename);
        // let libPath = path.join("../node_modules/.assembly", basename);
        console.log(path.resolve(file));
        if (await fs.pathExists(basename)) {
          console.log("using basename " + basename);
          file = basename;
        }
        let source = await fs.readFile(file);
        if (file.endsWith("wasa.ts")) {
          var stack = new Error().stack;
          console.log(Object.keys(asc.libraryFiles));
          console.log(stack);
        }
        console.log(`FILE: ${file} ${source.toString().substring(0, 40)}`);
        debugger;
        let sourceStr = source.toString();
        if (basename.startsWith("node_modules")) {
          let libname = basename.replace(/.*\.assembly\/(.*)\.ts/, "$1");
          // libname = libname.replace(/(.*)\/index/, "$1");
          console.log("------------------- " + libname);
          if (!asc.libraryFiles[libname]) asc.libraryFiles[libname] = sourceStr;
        }
        return sourceStr;
      } catch (e) {
        return null;
      }
    },
    writeFile: async (
      basename: string,
      content: Uint8Array,
      baseDir: string
    ) => {
      let base = baseDir ? baseDir : "";
      let file = path.join(base, basename);
      let folder = path.dirname(file);
      await mkdirp(folder); //Create parent folders
      await fs.writeFile(file, content, { flag: "w" });
    },
    listFiles: async (basename: string, baseDir: string): Promise<string[]> => {
      let base = baseDir ? baseDir : "";
      let dir = path.join(base, basename);
      console.log(dir);
      try {
        var files: string[] = [];
        files = await fs.readdir(dir);
      } catch (error) {
        try {
          files = await fs.readdir(await fs.realpath(dir));
        } catch (error) {
          throw error;
        }
      }
      return files;
    },
    stdout: asc.createMemoryStream(),
    stderr: asc.createMemoryStream(),
    outDir: "../dist/bin",
    baseDir: "./assembly",
    cmdline: [],
    mesaure: false,
    lib: true
  };

  static async compileOne(bin: string, _opts?: CompilerOptions): Promise<void> {
    console.log(process.cwd());
    let binPath = path.isAbsolute(bin) ? bin : path.join(process.cwd(), bin);

    let opts = this.mergeOpts(_opts);
    let folder = path.basename(bin).split(".")[0];

    let outDir = join(opts.outDir!, folder);
    let baseDir = this.findRoot(binPath);
    let relativeBin = path.relative(baseDir, binPath);
    let relativeDir = path.relative(process.cwd(), baseDir);
    let libraryPath = path.relative(
      process.cwd(),
      await linkLibrary(path.join(baseDir, ".."))
    );
    let allPaths = await glob(libraryPath + "/**/*.ts");
    await Promise.all(
      allPaths.map(async file => {
        let libname = file.replace(/.*\.assembly\/(.*)\.ts/, "$1");
        // libname = libname.replace(/(.*)\/index/, "$1");
        console.log("------------------- " + libname);
        asc.libraryFiles[libname] = (await opts.readFile!(file, "")) || "";
      })
    );

    let libFolders: string[] = opts.lib ? ["--lib", libraryPath] : [];

    var preamble: string[] = [];
    let preamblePath = path.join(baseDir, "preamble.ts");
    if (await fs.pathExists(preamblePath)) {
      preamble.push("preamble.ts");
    }
    preamble = preamble.concat(allPaths.filter(x => x.endsWith("preamble.ts")));
    console.log(`Preamble: ${preamble}`);
    console.log(`libfolders: ${libFolders}`);
    console.log(`all Paths: ${allPaths}`);

    let asc_opts = [
      relativeBin,
      "--baseDir",
      relativeDir,
      "--binaryFile",
      `${outDir}/index.wasm`,
      "--textFile",
      `${outDir}/index.wat`,
      "--tsdFile",
      `${outDir}/index.d.ts`,
      "--importMemory",
      "--measure",
      "--validate",
      "--debug"
    ].concat(libFolders);

    return new Promise((resolve, reject) => {
      (<any>asc).main(
        preamble.concat(asc_opts).concat(opts.cmdline!),
        { ...opts },
        (x: Error) => {
          if (x == null) {
            if (opts.mesaure) {
              let err = opts.stderr!.toString();
              console.log(err);
            }
            resolve();
          } else {
            console.error(opts.stderr!.toString());
            console.error(x);
            reject();
          }
        }
      );
    });
  }

  static findRoot(baseDir: string): string {
    while (isRoot(baseDir)) {
      baseDir = path.dirname(baseDir);
      if (path.basename(baseDir) === "assembly") {
        return baseDir;
      }
    }
    return this._opts.baseDir;
  }
}
