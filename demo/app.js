import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

import { glbToUsdz } from "../src/index.js";
import { buildCubeGlb, buildFeatureGlb } from "../test/cube-glb.js";
import { readUsdz } from "./usdz-reader.js";
import { parseUsda, traverse, primReferences } from "./usda-parser.js";
import { runChecks } from "./checks.js";
import { buildUsdScene } from "./usd-preview.js";

const $ = (id) => document.getElementById(id);
const USDA_DISPLAY_LIMIT = 300_000;

// ---------- Viewers (two canvases, one shared camera) ----------

const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.01, 1000);
camera.position.set(3, 2, 4);
const target = new THREE.Vector3();

function makeView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(cssVar("--viewer-bg"));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.GridHelper(10, 20, 0x888888, 0x888888));
  scene.children[0].material.opacity = 0.25;
  scene.children[0].material.transparent = true;
  const controls = new OrbitControls(camera, canvas);
  controls.target = target; // shared, so both views orbit together
  return { canvas, renderer, scene, controls, content: null };
}

const views = [makeView($("view-gltf")), makeView($("view-usd"))];

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  for (const v of views) v.scene.background.set(cssVar("--viewer-bg"));
});

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#808080";
}

function setContent(view, object) {
  if (view.content) {
    view.scene.remove(view.content);
    view.content.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [o.material].flat()) {
        if (!m) continue;
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose();
      }
    });
  }
  view.content = object;
  if (object) view.scene.add(object);
  applyWireframe();
}

function applyWireframe() {
  const on = $("wire").checked;
  for (const v of views) {
    v.content?.traverse((o) => {
      for (const m of [o.material].flat()) if (m) m.wireframe = on;
    });
  }
}

function frameCamera() {
  const box = new THREE.Box3();
  for (const v of views) if (v.content) box.expandByObject(v.content);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  box.getCenter(target);
  camera.near = size / 1000;
  camera.far = size * 100;
  camera.position.copy(target).add(new THREE.Vector3(0.6, 0.45, 0.8).normalize().multiplyScalar(size * 1.1));
  camera.updateProjectionMatrix();
  for (const v of views) {
    const grid = v.scene.children[0];
    grid.scale.setScalar(Math.max(size / 5, 0.2));
    grid.position.y = box.min.y;
  }
}

function loop() {
  for (const v of views) {
    const { canvas, renderer } = v;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    v.controls.update();
    renderer.render(v.scene, camera);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

$("wire").addEventListener("change", applyWireframe);
$("reset-cam").addEventListener("click", frameCamera);

// ---------- Input ----------

$("file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) loadFile(f);
});
$("sample").addEventListener("click", () => run(buildCubeGlb(), "sample-cube.glb"));
$("sample-features").addEventListener("click", () => run(buildFeatureGlb(), "sample-features.glb"));

let dragDepth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  run(new Uint8Array(await file.arrayBuffer()), file.name);
}

// ---------- Conversion ----------

let urls = [];
let usdPreview = null;

async function run(glb, name) {
  $("filename").textContent = `${name} (${fmtBytes(glb.length)})`;
  showError(null);
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  usdPreview?.dispose();
  usdPreview = null;

  // 1) Convert
  const converterWarnings = [];
  let usdz, ms;
  try {
    const t0 = performance.now();
    usdz = glbToUsdz(glb, { onWarning: (msg) => converterWarnings.push(msg) });
    ms = performance.now() - t0;
  } catch (err) {
    showError(`変換に失敗しました: ${err.message}`);
    console.error(err);
    setContent(views[1], null);
    overlay("usd", "変換に失敗しました", true);
    await showGltf(glb);
    return;
  }

  // 2) Read the package back and parse the layer
  let entries, layer, usdaText, parseError = null;
  try {
    entries = readUsdz(usdz);
    usdaText = new TextDecoder().decode(entries[0].data);
    layer = parseUsda(usdaText);
  } catch (err) {
    parseError = err;
    console.error(err);
  }

  // 3) Checks
  const checks = parseError
    ? [{ level: "error", msg: `出力を読み直せませんでした: ${parseError.message}` }]
    : runChecks(entries, layer);

  // 4) Previews
  await showGltf(glb);
  let previewWarnings = [];
  if (layer) {
    try {
      usdPreview = buildUsdScene(layer, entries);
      previewWarnings = usdPreview.warnings;
      setContent(views[1], usdPreview.object);
      overlay("usd", null);
    } catch (err) {
      console.error(err);
      setContent(views[1], null);
      overlay("usd", `プレビューに失敗: ${err.message}`, true);
    }
  } else {
    setContent(views[1], null);
    overlay("usd", "出力を解析できませんでした", true);
  }
  frameCamera();

  // 5) Downloads
  const base = name.replace(/\.glb$/i, "") || "model";
  const usdzUrl = URL.createObjectURL(new Blob([usdz], { type: "model/vnd.usdz+zip" }));
  const usdaUrl = URL.createObjectURL(new Blob([usdaText ?? ""], { type: "text/plain" }));
  urls.push(usdzUrl, usdaUrl);
  Object.assign($("dl-usdz"), { href: usdzUrl, download: `${base}.usdz` });
  Object.assign($("dl-usda"), { href: usdaUrl, download: `${base}.usda` });
  const ar = $("ar");
  ar.href = usdzUrl;
  ar.hidden = !supportsQuickLook();
  $("actions").hidden = false;

  // 6) Panels
  renderStats({ glb, usdz, usdaText, ms, layer, entries });
  renderChecks(checks, converterWarnings, previewWarnings);
  renderUsda(usdaText ?? "");
  renderTree(layer);
  renderPackage(entries);
  renderGltf(glb);
  $("panel").hidden = false;
}

function showGltf(glb) {
  return new Promise((resolve) => {
    const buf = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    new GLTFLoader().parse(buf, "", (gltf) => {
      fixTextureTransforms(gltf.scene);
      setContent(views[0], gltf.scene);
      overlay("gltf", null);
      resolve();
    }, (err) => {
      setContent(views[0], null);
      overlay("gltf", `GLTFLoader で読み込めませんでした: ${err.message ?? err}`, true);
      resolve();
    });
  });
}

/**
 * three.js' GLTFLoader maps KHR_texture_transform onto Texture.offset / repeat /
 * rotation, which three composes as uv' = S · R · uv + offset. The glTF spec is
 * uv' = T · R · S · uv, so the two differ when scale is non-uniform and rotation
 * is non-zero. Rebuild the matrix per spec so the reference view is correct.
 */
function fixTextureTransforms(root) {
  const seen = new Set();
  root.traverse((o) => {
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const tex of Object.values(m)) {
        if (!tex?.isTexture || seen.has(tex) || tex.rotation === 0) continue;
        seen.add(tex);
        const c = Math.cos(tex.rotation), s = Math.sin(tex.rotation);
        const [sx, sy] = [tex.repeat.x, tex.repeat.y];
        tex.matrixAutoUpdate = false;
        tex.matrix.set(c * sx, s * sy, tex.offset.x, -s * sx, c * sy, tex.offset.y, 0, 0, 1);
      }
    }
  });
}

// ---------- Rendering helpers ----------

function overlay(which, msg, isErr = false) {
  const el = $(`overlay-${which}`);
  el.hidden = !msg;
  el.textContent = msg ?? "";
  el.classList.toggle("err", isErr);
}

function showError(msg) {
  $("error").hidden = !msg;
  $("error").textContent = msg ?? "";
}

function renderStats({ glb, usdz, usdaText, ms, layer, entries }) {
  const counts = {};
  let instances = 0;
  if (layer) {
    for (const p of traverse(layer.prims)) {
      counts[p.type || "(typeless)"] = (counts[p.type || "(typeless)"] ?? 0) + 1;
      if (p.metadata.instanceable) instances++;
    }
  }
  const items = [
    [fmtBytes(glb.length), "入力 GLB"],
    [fmtBytes(usdz.length), "USDZ"],
    [fmtBytes(new TextEncoder().encode(usdaText ?? "").length), "うち USDA"],
    [`${ms.toFixed(1)} ms`, "変換時間"],
    [counts.Mesh ?? 0, "Mesh"],
    [instances, "インスタンス"],
    [counts.Material ?? 0, "Material"],
    [entries ? entries.length - 1 : 0, "テクスチャ"],
  ];
  $("stats").innerHTML = items.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");
  $("stats").hidden = false;
}

function renderChecks(checks, converterWarnings, previewWarnings) {
  const errors = checks.filter((c) => c.level === "error").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  const summary = errors
    ? `<p class="summary error">エラー ${errors} 件 / 警告 ${warns} 件</p>`
    : `<p class="summary ok">エラーなし${warns ? `（警告 ${warns} 件）` : ""}</p>`;
  const list = (items) => `<ul class="checks">${items.map((c) => `<li class="${c.level}">${esc(c.msg)}</li>`).join("")}</ul>`;
  let html = summary + "<h3>出力ファイルの構造チェック</h3>" + list(checks);
  html += "<h3>変換時の警告（options.onWarning）</h3>";
  html += converterWarnings.length ? list(converterWarnings.map((msg) => ({ level: "warn", msg }))) : '<p class="hint">なし</p>';
  html += "<h3>プレビューで表現できなかったもの</h3>";
  html += previewWarnings.length ? list(previewWarnings.map((msg) => ({ level: "warn", msg }))) : '<p class="hint">なし</p>';
  $("tab-checks").innerHTML = html;
}

function renderUsda(text) {
  $("usda-text").textContent = text.length > USDA_DISPLAY_LIMIT
    ? text.slice(0, USDA_DISPLAY_LIMIT) + `\n\n… 残り ${fmtBytes(text.length - USDA_DISPLAY_LIMIT)} は省略（全文は「USDA をダウンロード」から）`
    : text;
}

function renderTree(layer) {
  if (!layer) { $("tab-tree").innerHTML = '<p class="hint">解析できませんでした</p>'; return; }
  const node = (p) => {
    const meta = [];
    if (p.type === "Mesh") {
      meta.push(`${p.props.get("points")?.value?.length ?? 0} 頂点`, `${p.props.get("faceVertexCounts")?.value?.length ?? 0} 面`);
      const b = p.props.get("material:binding")?.value?.[0];
      if (b) meta.push(`→ ${b}`);
    }
    if (p.type === "Shader") meta.push(String(p.props.get("info:id")?.value ?? ""));
    if (p.type === "Xform" && p.props.has("xformOpOrder")) meta.push(p.props.get("xformOpOrder").value.join(", "));
    for (const r of primReferences(p)) meta.push(`${p.metadata.instanceable ? "instance of" : "ref"} ${r.asset ? `@${r.asset}@` : ""}${r.path ?? ""}`);
    if (p.specifier === "class") meta.push("class（描画されない）");
    const kids = p.children.length ? `<ul>${p.children.map(node).join("")}</ul>` : "";
    return `<li><span class="type">${esc(p.type || "def")}</span><span class="name">${esc(p.name)}</span><span class="meta">${esc(meta.join(" · "))}</span>${kids}</li>`;
  };
  $("tab-tree").innerHTML = `<ul class="tree">${layer.prims.map(node).join("")}</ul>`;
}

function renderPackage(entries) {
  if (!entries) { $("tab-package").innerHTML = '<p class="hint">解析できませんでした</p>'; return; }
  const rows = entries.map((e) => `<tr>
    <td class="name">${esc(e.name)}</td>
    <td class="num">${fmtBytes(e.size)}</td>
    <td class="num">${e.dataOffset}</td>
    <td>${e.aligned ? "✓" : "✕"}</td>
    <td>${e.method === 0 ? "stored" : `method ${e.method}`}</td>
    <td>${e.crcOk ? "✓" : "✕"}</td></tr>`).join("");
  $("tab-package").innerHTML = `<table><thead><tr><th>エントリ</th><th>サイズ</th><th>データ開始</th><th>64B 境界</th><th>圧縮</th><th>CRC</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderGltf(glb) {
  let json;
  try {
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
  } catch {
    $("tab-gltf").innerHTML = '<p class="hint">JSON チャンクを読めませんでした</p>';
    return;
  }
  const n = (k) => json[k]?.length ?? 0;
  const prims = (json.meshes ?? []).reduce((a, m) => a + (m.primitives?.length ?? 0), 0);
  const rows = [
    ["generator", json.asset?.generator ?? "—"],
    ["scenes / nodes", `${n("scenes")} / ${n("nodes")}`],
    ["meshes / primitives", `${n("meshes")} / ${prims}`],
    ["materials / textures / images", `${n("materials")} / ${n("textures")} / ${n("images")}`],
    ["animations / skins / cameras", `${n("animations")} / ${n("skins")} / ${n("cameras")}`],
    ["extensionsUsed", (json.extensionsUsed ?? []).join(", ") || "—"],
    ["extensionsRequired", (json.extensionsRequired ?? []).join(", ") || "—"],
  ];
  let html = `<table><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="name">${esc(v)}</td></tr>`).join("")}</tbody></table>`;
  if (n("animations") || n("skins")) html += '<p class="hint">アニメーション / スキンは未対応です（段階 3・4）。出力には含まれません。</p>';
  $("tab-gltf").innerHTML = html;
}

// Tabs
for (const btn of document.querySelectorAll(".tabs button")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tabs button")) {
      b.setAttribute("aria-selected", String(b === btn));
      $(`tab-${b.dataset.tab}`).hidden = b !== btn;
    }
  });
}

// AR Quick Look exists only in Safari on iOS / iPadOS (iPadOS reports itself as a Mac).
function supportsQuickLook() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return ios && document.createElement("a").relList.supports("ar");
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
