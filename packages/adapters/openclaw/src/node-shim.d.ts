declare module "node:fs" { const x: any; export = x; }
declare module "node:path" { const x: any; export = x; }
declare module "node:os" { const x: any; export = x; }
declare module "node:crypto" {
  export function randomUUID(): string;
  const x: any;
  export = x;
}
declare var process: any;
