import type { ZodTypeAny } from "zod";

/**
 * Conversor Zod -> JSON Schema minimalista e sem dependências.
 * Cobre apenas o subconjunto usado neste projeto (object, string, number,
 * boolean, enum, nativeEnum, optional, effects/refine). Suficiente para gerar
 * um documento OpenAPI 3.0 fiel aos schemas reais.
 */
export type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = (schema as { _def: any })._def;
  const typeName: string = def.typeName;

  switch (typeName) {
    case "ZodEffects":
      // .refine()/.transform() — converte o schema interno
      return zodToJsonSchema(def.schema);

    case "ZodOptional":
    case "ZodNullable":
      return zodToJsonSchema(def.innerType);

    case "ZodDefault":
      return zodToJsonSchema(def.innerType);

    case "ZodObject": {
      const shape: Record<string, ZodTypeAny> = def.shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length) out.required = required;
      return out;
    }

    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      for (const check of def.checks ?? []) {
        if (check.kind === "email") out.format = "email";
        if (check.kind === "min") out.minLength = check.value;
        if (check.kind === "max") out.maxLength = check.value;
        if (check.kind === "regex") out.pattern = check.regex.source;
      }
      return out;
    }

    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") out.minimum = check.value;
        if (check.kind === "max") out.maximum = check.value;
        if (check.kind === "int") out.type = "integer";
      }
      return out;
    }

    case "ZodBoolean":
      return { type: "boolean" };

    case "ZodDate":
      return { type: "string", format: "date-time" };

    case "ZodArray": {
      const out: JsonSchema = { type: "array", items: zodToJsonSchema(def.type) };
      if (def.minLength) out.minItems = def.minLength.value;
      if (def.maxLength) out.maxItems = def.maxLength.value;
      return out;
    }

    case "ZodLiteral":
      return { const: def.value };

    case "ZodEnum":
      return { type: "string", enum: [...def.values] };

    case "ZodNativeEnum":
      return { type: "string", enum: Object.values(def.values) };

    default:
      return {};
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const typeName = (schema as { _def: any })._def.typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}
