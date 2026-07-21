declare module "tar" {
  import { PassThrough } from "stream";

  interface ExtractOptions {
    cwd?: string;
    sync?: boolean;
    strip?: number;
    filter?: (path: string, entry: import("fs").Stats) => boolean;
    [key: string]: unknown;
  }

  interface PackOptions {
    cwd?: string;
    gzip?: boolean;
    portable?: boolean;
    filter?: (path: string, entry: import("fs").Stats) => boolean;
    [key: string]: unknown;
  }

  interface ListOptions {
    cwd?: string;
    filter?: (path: string, entry: import("fs").Stats) => boolean;
    [key: string]: unknown;
  }

  export class Extract extends PassThrough {
    constructor(options?: ExtractOptions);
  }

  export class Pack extends PassThrough {
    constructor(options?: PackOptions);
  }

  export function extract(options: ExtractOptions): Extract;
  export function pack(options?: PackOptions): Pack;
  export function x(options: ExtractOptions): Promise<void>;
  export function c(options: PackOptions, fileList?: string[]): Pack;
  export function t(options: ListOptions): Promise<string[]>;
}
