/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "tar" {
  import { Stream } from "stream";

  interface ExtractOptions {
    cwd?: string;
    sync?: boolean;
    strip?: number;
    filter?: (path: string, entry: any) => boolean;
    [key: string]: any;
  }

  interface PackOptions {
    cwd?: string;
    [key: string]: any;
  }

  export function extract(options: ExtractOptions): Stream;
  export function pack(options?: PackOptions): Stream;
  export function x(options: ExtractOptions): Promise<void>;
  export function c(options: PackOptions, fileList: string[]): Promise<void>;
  export function t(options: any): Promise<string[]>;
}
