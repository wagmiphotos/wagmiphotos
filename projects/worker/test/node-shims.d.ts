// This project has no @types/node (workers-types would conflict with it in
// src). test/contract.test.ts reads wrangler.toml off disk to check it
// against contract.json, so it needs these two Node builtins — declared
// ambiently here (a script file, not a module) rather than pulling in a
// global Node type dependency for the whole project.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
}
declare module "node:path" {
  export function join(...paths: string[]): string;
}
declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
declare module "node:module" {
  export function createRequire(filename: string): NodeRequire;
  interface NodeRequire {
    (id: string): any;
  }
}
declare const __dirname: string;

// test/real-d1.ts uses import.meta.url to locate the migrations dir relative
// to this test file; this project's tsconfig has no DOM/node lib pulling in
// the ambient ImportMeta.url member, so declare it globally (test-only need).
declare interface ImportMeta {
  url: string;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, opts?: { enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): { get(...a: any[]): any; run(...a: any[]): any; all(...a: any[]): any[] };
  }
}

