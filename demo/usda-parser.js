// Minimal USDA (text) parser used by the demo's preview and checks.
// It covers the subset gltf2usd.js writes (plus a little more) and is written
// independently of src/usda.js so that it actually reads the output back.
//
// Result:
//   { metadata: {key: value}, prims: Prim[] }
//   Prim = { specifier, type, name, path, metadata, props: Map<name, Prop>, children: Prim[], parent }
//   Prop = { name, type, isArray, uniform, isRel, value, connect, timeSamples, metadata }

export function parseUsda(text) {
  if (!/^#usda 1\.0/.test(text)) throw new Error("Not a USDA 1.0 layer (missing #usda 1.0 header)");
  const p = new Parser(tokenize(text));
  const layer = { metadata: {}, prims: [] };
  if (p.peekPunct("(")) layer.metadata = p.parseMetadata();
  while (!p.done()) {
    layer.prims.push(p.parsePrim(null, ""));
  }
  return layer;
}

/** Depth-first iterator over prims. */
export function* traverse(prims) {
  for (const prim of prims) {
    yield prim;
    yield* traverse(prim.children);
  }
}

/** Build a Map<path, Prim> for path lookups. */
export function indexPrims(layer) {
  const map = new Map();
  for (const prim of traverse(layer.prims)) map.set(prim.path, prim);
  return map;
}

// ---------- Tokenizer ----------

const PUNCT = new Set(["(", ")", "[", "]", "{", "}", "=", ",", ";", ":"]);

function tokenize(text) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  // Skip the "#usda 1.0" header line (it is a comment syntactically).
  while (i < n) {
    const ch = text[i];
    if (ch === "\n") { line++; i++; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    if (ch === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      let j = i + quote.length;
      let s = "";
      while (j < n && !text.startsWith(quote, j)) {
        if (text[j] === "\\" && j + 1 < n) {
          const e = text[j + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
        } else {
          if (text[j] === "\n") line++;
          s += text[j++];
        }
      }
      if (j >= n) throw syntaxError("Unterminated string", line);
      tokens.push({ t: "string", v: s, line });
      i = j + quote.length;
      continue;
    }
    if (ch === "@") {
      const triple = text.startsWith("@@@", i);
      const q = triple ? "@@@" : "@";
      const end = text.indexOf(q, i + q.length);
      if (end < 0) throw syntaxError("Unterminated asset path", line);
      tokens.push({ t: "asset", v: text.slice(i + q.length, end), line });
      i = end + q.length;
      continue;
    }
    if (ch === "<") {
      const end = text.indexOf(">", i);
      if (end < 0) throw syntaxError("Unterminated path", line);
      tokens.push({ t: "path", v: text.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }
    if (/[0-9+\-.]/.test(ch) && /[0-9.]/.test(text[i + 1] ?? "") || /[0-9]/.test(ch)) {
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
      if (m) {
        tokens.push({ t: "number", v: Number(m[0]), line });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch)) {
      // Identifiers may be namespaced (a:b:c) and carry a .connect / .timeSamples suffix.
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:[:.][A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(i, i + 512));
      tokens.push({ t: "ident", v: m[0], line });
      i += m[0].length;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ t: "punct", v: ch, line });
      i++;
      continue;
    }
    if (ch === "-" && text.startsWith("-inf", i)) {
      tokens.push({ t: "number", v: -Infinity, line });
      i += 4;
      continue;
    }
    throw syntaxError(`Unexpected character '${ch}'`, line);
  }
  return tokens;
}

function syntaxError(msg, line) {
  return new Error(`USDA syntax error (line ${line}): ${msg}`);
}

// ---------- Parser ----------

const SPECIFIERS = new Set(["def", "over", "class"]);
const LIST_OPS = new Set(["prepend", "append", "add", "delete", "reorder"]);
const QUALIFIERS = new Set(["custom", "uniform", "varying", "config"]);

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }

  done() { return this.i >= this.tokens.length; }
  peek(k = 0) { return this.tokens[this.i + k]; }
  peekPunct(v, k = 0) { const t = this.peek(k); return t && t.t === "punct" && t.v === v; }
  next() {
    const t = this.tokens[this.i++];
    if (!t) throw new Error("USDA syntax error: unexpected end of file");
    return t;
  }
  expectPunct(v) {
    const t = this.next();
    if (t.t !== "punct" || t.v !== v) throw syntaxError(`Expected '${v}' but got '${t.v}'`, t.line);
    return t;
  }
  expect(type) {
    const t = this.next();
    if (t.t !== type) throw syntaxError(`Expected ${type} but got '${t.v}'`, t.line);
    return t;
  }

  parsePrim(parent, parentPath) {
    const spec = this.expect("ident");
    if (!SPECIFIERS.has(spec.v)) throw syntaxError(`Expected def/over/class but got '${spec.v}'`, spec.line);
    let type = "";
    if (this.peek()?.t === "ident") type = this.next().v;
    const name = this.expect("string").v;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw syntaxError(`Invalid prim name "${name}"`, spec.line);
    const prim = {
      specifier: spec.v, type, name,
      path: `${parentPath}/${name}`,
      metadata: {}, props: new Map(), children: [], parent, line: spec.line,
    };
    if (this.peekPunct("(")) prim.metadata = this.parseMetadata();
    this.expectPunct("{");
    const childNames = new Set();
    while (!this.peekPunct("}")) {
      const t = this.peek();
      if (!t) throw syntaxError(`Unterminated prim ${prim.path}`, spec.line);
      if (t.t === "ident" && SPECIFIERS.has(t.v) && this.peek(1)?.t !== "punct") {
        const child = this.parsePrim(prim, prim.path);
        if (childNames.has(child.name)) throw syntaxError(`Duplicate prim ${child.path}`, child.line);
        childNames.add(child.name);
        prim.children.push(child);
      } else if (t.t === "ident" && t.v === "variantSet") {
        throw syntaxError("variantSet is not supported by this preview parser", t.line);
      } else {
        this.parseProperty(prim);
      }
      if (this.peekPunct(";")) this.next();
    }
    this.expectPunct("}");
    return prim;
  }

  parseProperty(prim) {
    const first = this.peek();
    let uniform = false;
    while (this.peek()?.t === "ident" && QUALIFIERS.has(this.peek().v)) {
      if (this.next().v === "uniform") uniform = true;
    }
    const typeTok = this.expect("ident");
    let isRel = typeTok.v === "rel";
    let isArray = false;
    if (!isRel && this.peekPunct("[") && this.peekPunct("]", 1)) {
      this.next(); this.next();
      isArray = true;
    }
    const nameTok = this.expect("ident");
    let name = nameTok.v;
    let suffix = null;
    for (const s of [".connect", ".timeSamples"]) {
      if (name.endsWith(s)) { suffix = s; name = name.slice(0, -s.length); }
    }

    let prop = prim.props.get(name);
    if (!prop) {
      prop = { name, type: isRel ? "rel" : typeTok.v, isArray, uniform, isRel, value: undefined, connect: undefined, timeSamples: undefined, metadata: {}, line: first.line };
      prim.props.set(name, prop);
    }
    if (this.peekPunct("=")) {
      this.next();
      if (suffix === ".connect") {
        const v = this.parseValue();
        prop.connect = Array.isArray(v) ? v.map((p) => p.path) : [v.path];
      } else if (suffix === ".timeSamples") {
        prop.timeSamples = this.parseTimeSamples();
      } else if (isRel) {
        const v = this.parseValue();
        prop.value = Array.isArray(v) ? v.map((p) => p.path) : v === null ? [] : [v.path];
      } else {
        prop.value = this.parseValue();
      }
    }
    if (this.peekPunct("(")) Object.assign(prop.metadata, this.parseMetadata());
  }

  parseTimeSamples() {
    this.expectPunct("{");
    const samples = [];
    while (!this.peekPunct("}")) {
      const time = this.expect("number").v;
      this.expectPunct(":");
      samples.push([time, this.parseValue()]);
      if (this.peekPunct(",")) this.next();
    }
    this.expectPunct("}");
    return samples;
  }

  parseMetadata() {
    this.expectPunct("(");
    const md = {};
    while (!this.peekPunct(")")) {
      const t = this.next();
      if (t.t === "string") { md.doc = t.v; continue; }
      if (t.t === "punct" && t.v === ";") continue;
      if (t.t !== "ident") throw syntaxError(`Unexpected '${t.v}' in metadata`, t.line);
      let key = t.v;
      if (LIST_OPS.has(key)) key = `${key} ${this.expect("ident").v}`;
      if (this.peekPunct("=")) {
        this.next();
        md[key] = this.parseValue();
      } else {
        md[key] = true;
      }
    }
    this.expectPunct(")");
    return md;
  }

  parseValue() {
    const t = this.next();
    switch (t.t) {
      case "number": return t.v;
      case "string": return t.v;
      case "asset": return { asset: t.v };
      case "path": return { path: t.v };
      case "ident":
        if (t.v === "None") return null;
        if (t.v === "inf") return Infinity;
        if (t.v === "nan") return NaN;
        if (t.v === "true") return true;
        if (t.v === "false") return false;
        return t.v; // bare token
      case "punct":
        if (t.v === "(" || t.v === "[") {
          const close = t.v === "(" ? ")" : "]";
          const items = [];
          while (!this.peekPunct(close)) {
            items.push(this.parseValue());
            if (this.peekPunct(",")) this.next();
          }
          this.next();
          if (t.v === "(") items.tuple = true;
          return items;
        }
        if (t.v === "{") {
          // Dictionary (customData etc.): skip balanced braces; not needed for preview.
          let depth = 1;
          while (depth > 0) {
            const u = this.next();
            if (u.t === "punct" && u.v === "{") depth++;
            if (u.t === "punct" && u.v === "}") depth--;
          }
          return {};
        }
    }
    throw syntaxError(`Unexpected '${t.v}' where a value was expected`, t.line);
  }
}
