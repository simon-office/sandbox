declare module 'node:os' {
  export function homedir(): string;
}

declare module 'node:fs' {
  export function mkdirSync(path: string, options: { recursive: boolean }): void;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
      run(...values: unknown[]): unknown;
    };
    close(): void;
  }
}

declare const process: { env: Record<string, string | undefined> };
