export class OpenAI {
  constructor() {}
  chat = {
    completions: {
      create: async () => ({
        choices: [{ message: { content: "mock response" } }],
      }),
    },
  };
}
