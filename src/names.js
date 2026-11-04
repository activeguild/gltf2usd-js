// USD identifiers for prims and joints.

/** USD prim names must match [A-Za-z_][A-Za-z0-9_]*. */
export function sanitize(name, fallback) {
  if (!name) return fallback;
  let s = String(name).replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "_" + s;
  return s || fallback;
}

/** Make `name` unique within `used` (name, name_1, name_2, ...) and record it. */
export function uniqueName(name, used) {
  let candidate = name;
  let i = 1;
  while (used.has(candidate)) candidate = `${name}_${i++}`;
  used.add(candidate);
  return candidate;
}
