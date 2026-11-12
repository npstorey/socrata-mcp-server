import { createHash } from 'node:crypto';

/**
 * `mcpToolSchemaSha256(tool)`: the lowercase hex SHA-256 of the RFC 8785 canonical JSON of
 * `{ name, inputSchema }`, as the server's own `tools/list` returned that tool, with the
 * annotation keywords `title` and `description` removed from every schema object first.
 *
 * This is a copy of the hub router's `mcpToolSchemaSha256` (`@typedstandards/civic-typed-router`
 * 0.9.0, released after this file merges). The repository takes no dependency on the router, so
 * the rule is restated here. The two worked cases in `pinned-identity.test.ts`, and the two wrong
 * walks they tell apart, are the sprint contract's (npstorey/civic-ai-tools#317); both copies
 * reproduce them, which is what holds the two equal.
 *
 * The walk. Only keywords that hold subschemas are walked, and in each schema reached `title`
 * and `description` are removed. An argument that is itself named `title` or `description` is a
 * member of `properties`, not a keyword, so it is kept.
 *  - by name (each member's value is a schema): `properties`, `patternProperties`, `$defs`,
 *    `definitions`, `dependentSchemas`;
 *  - one schema: `items`, `additionalProperties`, `not`, `if`, `then`, `else`, `contains`,
 *    `propertyNames`;
 *  - a list of schemas: `items` when it holds an array, `anyOf`, `oneOf`, `allOf`, `prefixItems`.
 * Every other keyword is kept whole and not walked: the data keywords `default`, `const`, `enum`
 * and `examples`, and every keyword the rule does not name (`additionalItems`,
 * `unevaluatedProperties`, `dependencies`, `contentSchema`, ...). A boolean schema has nothing to
 * remove.
 *
 * RFC 8785, for JSON values (the input is the wire form, so no `undefined` and no functions):
 * object members sorted by their names' UTF-16 code units, no whitespace, strings and numbers as
 * `JSON.stringify` writes them, and `true`, `false` and `null` as literals.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ANNOTATIONS = new Set(['title', 'description']);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const ONE_SCHEMA = new Set([
  'items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'
]);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

const isObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One schema with `title` and `description` removed from it and from every subschema it holds. */
export function stripAnnotations(schema: Json): Json {
  if (!isObject(schema)) return schema; // a boolean schema, or a value that is not a schema
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      const members: { [key: string]: Json } = {};
      for (const [name, member] of Object.entries(value)) members[name] = stripAnnotations(member);
      out[key] = members;
    } else if (key === 'items' && Array.isArray(value)) {
      out[key] = value.map(stripAnnotations);
    } else if (ONE_SCHEMA.has(key)) {
      out[key] = stripAnnotations(value);
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) {
      out[key] = value.map(stripAnnotations);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** RFC 8785 canonical JSON of a JSON value. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    // Array.prototype.sort's default order compares UTF-16 code units, as RFC 8785 requires.
    const names = Object.keys(value).sort();
    return `{${names.map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The canonical text the hash is taken over: `{ name, inputSchema }`, annotations removed. */
export function mcpToolSchemaCanonical(tool: { name: string; inputSchema: Json }): string {
  return canonicalJson({ name: tool.name, inputSchema: stripAnnotations(tool.inputSchema) });
}

export function mcpToolSchemaSha256(tool: { name: string; inputSchema: Json }): string {
  return createHash('sha256').update(mcpToolSchemaCanonical(tool), 'utf8').digest('hex');
}
