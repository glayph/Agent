import { z } from "zod";
import { jsonSchemaToShape } from "./json-schema.js";

describe("jsonSchemaToShape", () => {
  test("converts required, optional, enum, arrays, and nested objects", () => {
    const shape = jsonSchemaToShape({
      type: "object",
      properties: {
        name: { type: "string" },
        mode: { type: "string", enum: ["fast", "safe"] },
        tags: { type: "array", items: { type: "string" } },
        meta: {
          type: "object",
          properties: {
            count: { type: "integer" },
          },
          required: ["count"],
        },
      },
      required: ["name", "mode"],
    });

    const schema = z.object(shape);
    expect(
      schema.parse({
        name: "demo",
        mode: "fast",
        tags: ["mcp"],
        meta: { count: 2 },
      }),
    ).toEqual({
      name: "demo",
      mode: "fast",
      tags: ["mcp"],
      meta: { count: 2 },
    });
    expect(() => schema.parse({ name: "demo", mode: "other" })).toThrow();
    expect(schema.parse({ name: "demo", mode: "safe" })).toEqual({
      name: "demo",
      mode: "safe",
    });
  });
});
