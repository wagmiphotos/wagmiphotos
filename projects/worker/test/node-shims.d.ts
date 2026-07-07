// This project has no @types/node (workers-types would conflict with it in
// src). test/contract.test.ts reads wrangler.toml off disk to check it
// against contract.json, so it needs these two Node builtins — declared
// ambiently here (a script file, not a module) rather than pulling in a
// global Node type dependency for the whole project.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:path" {
  export function join(...paths: string[]): string;
}
declare const __dirname: string;
