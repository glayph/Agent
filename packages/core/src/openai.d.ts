declare module "openai" {
  class OpenAI {
    constructor(options: { apiKey?: string; baseURL?: string; timeout?: number; maxRetries?: number });
    chat: OpenAI.Chat;
    models: { list(): Promise<{ data: Array<{ id: string }> }> };
  }

  namespace OpenAI {
    export class AzureOpenAI {
      constructor(options: any);
    }
    export namespace Chat {
      export namespace Completions {
        export interface ChatCompletionMessageParam {
          role: string;
          content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>;
          name?: string;
          tool_calls?: any[];
          tool_call_id?: string;
        }
        export interface ChatCompletion {
          id: string;
          object: string;
          created: number;
          model: string;
          choices: Array<{
            index: number;
            message: {
              role: string;
              content: string | null;
              tool_calls?: any[];
            };
            finish_reason: string;
          }>;
          usage?: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
          };
        }
      }
    }
  }

  export default OpenAI;
  export function toFile(content: any, filename?: string, options?: any): any;
  export function toFileableStream(content: any): any;
}