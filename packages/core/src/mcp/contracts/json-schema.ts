import { z } from "zod";

const TYPE_MAP: Record<string, () => z.ZodTypeAny> = {
  string: () => z.string(),
  integer: () => z.number().int(),
  number: () => z.number(),
  boolean: () => z.boolean(),
  array: () => z.array(z.any()),
  object: () => z.record(z.any()),
};

export function jsonPropToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const propType = prop.type as string | undefined;

  if (prop.enum && Array.isArray(prop.enum)) {
    return z.enum(prop.enum.map(String) as [string, ...string[]]);
  }

  if (propType === "array" && prop.items && typeof prop.items === "object") {
    const itemSchema = jsonPropToZod(prop.items as Record<string, unknown>);
    let field = z.array(itemSchema);
    if (prop.description) field = field.describe(prop.description as string);
    return field;
  }

  if (
    propType === "object" &&
    prop.properties &&
    typeof prop.properties === "object"
  ) {
    const shape = jsonSchemaToShape(prop);
    let field = z.object(shape);
    if (prop.description) field = field.describe(prop.description as string);
    return field;
  }

  const factory = TYPE_MAP[propType || "string"] || (() => z.any());
  let field = factory();
  if (prop.description) field = field.describe(prop.description as string);
  return field;
}

export function jsonSchemaToShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const props = schema.properties as
    Record<string, Record<string, unknown>> | undefined;
  if (!props) return {};
  const required = new Set<string>((schema.required as string[]) || []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(props)) {
    let field = jsonPropToZod(prop);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }

  return shape;
}
