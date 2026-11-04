// Small in-memory description of a USD layer: prims, attributes, relationships
// and metadata. src/convert.js builds it from glTF; src/usda.js writes it as
// text (and a future USDC writer can write the same tree as binary).
//
// Value conventions (by attribute typeName):
//   scalar types (float, int, bool, token, string, asset, ...)  → number / string
//   tuple types (float3, color3f, quatf (w, x, y, z), ...)      → flat number array
//   matrix4d                                                     → 16 numbers, row-major as written in USD
//   T[] arrays                                                    → flat array (tuples flattened)
// Prim / property metadata values:
//   string → quoted, number, boolean, string[] → token list, { path } → <path>

export class Layer {
  constructor(metadata = {}) {
    /** Ordered layer metadata, e.g. { defaultPrim: "Root", metersPerUnit: 1 }. */
    this.metadata = metadata;
    /** @type {Prim[]} */
    this.prims = [];
  }

  /** @param {Prim} prim */
  add(prim) {
    this.prims.push(prim);
    return prim;
  }
}

export class Prim {
  /**
   * @param {string} type      schema type name ("Xform", "Mesh", ...) or "" for typeless
   * @param {string} name      valid USD identifier
   * @param {object} [opts]
   * @param {"def"|"over"|"class"} [opts.specifier]
   * @param {object} [opts.metadata]  ordered prim metadata ("prepend apiSchemas", "instanceable", ...)
   * @param {boolean} [opts.spaced]   text writer: blank line between children (cosmetic only)
   */
  constructor(type, name, { specifier = "def", metadata = {}, spaced = false } = {}) {
    this.specifier = specifier;
    this.type = type;
    this.name = name;
    this.metadata = metadata;
    this.spaced = spaced;
    /** @type {(Attribute|Relationship)[]} */
    this.props = [];
    /** @type {Prim[]} */
    this.children = [];
  }

  /**
   * Add an attribute.
   * @param {string} typeName  e.g. "point3f[]", "token", "matrix4d"
   * @param {string} name      e.g. "points", "inputs:file"
   * @param {*} [value]        default value (undefined = declared only)
   * @param {object} [opts]
   * @param {boolean} [opts.uniform]
   * @param {string} [opts.connect]                 connection source path (Prim.path.attr)
   * @param {[number, *][]} [opts.timeSamples]      [timeCode, value] pairs
   * @param {object} [opts.metadata]                e.g. { interpolation: "vertex" }
   */
  attr(typeName, name, value, opts = {}) {
    this.props.push({
      kind: "attr",
      typeName,
      name,
      value,
      uniform: !!opts.uniform,
      connect: opts.connect,
      timeSamples: opts.timeSamples,
      metadata: opts.metadata ?? {},
    });
    return this;
  }

  /** Add a relationship with zero or more target paths. */
  rel(name, targets = []) {
    this.props.push({ kind: "rel", name, targets: [targets].flat() });
    return this;
  }

  /** Append a child prim and return it. */
  child(prim) {
    this.children.push(prim);
    return prim;
  }
}
