# gltf2usd.js — 引き継ぎ書 / Claude Code 用コンテキスト

## プロジェクトの目的

GLB（glTF 2.0 binary）を USD（USDA / USDZ、将来 USDC）に変換する **依存ゼロの JavaScript ライブラリ**。
ブラウザと Node の両方で同じコードが動くこと（ESM、`ArrayBuffer` / `DataView` / `TextEncoder` のみ使用）が最重要の制約。
Node 固有 API（`fs`, `Buffer`）は `cli.js` と `test/` の中だけで使い、`src/` には持ち込まない。

npm パッケージ名: `gltf2usd-js`。

## 現在の状態（段階 1・2 完了。KHR_materials_transmission の扱いのみ要相談）

`src/` 4 ファイル、合計 ~1000 行。テスト GLB（`cube.glb`、段階 2 の機能を詰めた `features.glb`、外部ファイル付き `gltf/cube.gltf`）と
Khronos サンプル（BoxTextured / CesiumMilkTruck / DamagedHelmet）を OpenUSD 26.11 の全 30 バリデータに通して error 0 を確認済み。

| ファイル | 役割 | 備考 |
|---|---|---|
| `src/glb.js`  | `parseGLB()`, `GltfAsset` | accessor デコード（byteStride / normalized / sparse 対応）、`imageBytes()` |
| `src/convert.js` | `gltfToStage(asset, opts)` → `{ layer, files }`（glTF → USD IR） | ノード階層、Mesh、UsdPreviewSurface、警告 |
| `src/ir.js` | `Layer` / `Prim`（`attr()` / `rel()` / `child()`） | USD 側のプリム・属性ツリー。値の表現規約は冒頭コメント |
| `src/usda.js` | `writeUsda(layer)` → USDA 文字列 | 型名から書式を決める。timeSamples 対応 |
| `src/usdz.js` | `packUsdz(entries)` → `Uint8Array` | stored-only zip、64 バイトアライン、CRC32 自前 |
| `src/index.js`| `glbToUsda()`, `glbToUsdz()`, `gltfToUsda()` | 公開 API。名前は glb だが `.gltf` も受け付ける |
| `cli.js`      | `node cli.js in.glb\|in.gltf out.usdz\|out.usda` | `.gltf` の外部ファイルは同じフォルダ以下からのみ読む |
| `test/cube-glb.js` | テスト用 GLB をメモリ上で生成（Node / ブラウザ共用） | `buildCubeGlb()`（段階 1）、`buildFeatureGlb()`（段階 2 の機能） |
| `test/make-glb.js` | `test/cube.glb`、`test/features.glb`、`test/gltf/`（外部ファイル付き .gltf）を書き出す | |
| `test/png.js` | テスト画像用の小さな PNG エンコーダ | |
| `test/run.js` | JS 側の単体テスト（prim 名、zip アライン検証） | `npm test` |
| `test/validate.py` | OpenUSD で開いてバリデータ実行 | `pip install usd-core` が必要 |
| `demo/` | Web テストアプリ（`npm run demo` → `http://localhost:8080/demo/`） | 下記 |

### Web デモ（`demo/`）
- `index.html` / `app.js` / `style.css`: GLB を変換し、glTF（GLTFLoader）と USD を並べて表示、チェック結果・USDA・Prim ツリー・zip エントリを表示
- `usda-parser.js`: USDA の汎用パーサ（`src/usda.js` とは独立に実装。出力を読み戻すため）
- `usd-preview.js`: パース結果から three.js シーンを組み立てる（xformOp、Mesh の各 interpolation、UsdPreviewSurface + UsdUVTexture、
  internal reference の簡易合成。インスタンス間でジオメトリを共有）。
  表現できないものは「プレビューで表現できなかったもの」に出る
- `checks.js`: 構造チェック（zip アライン / 圧縮 / CRC、Mesh トポロジ、primvar 要素数、binding、シェーダ接続、テクスチャ参照）
- `usdz-reader.js`: zip の central directory を読む
- `server.js`: 依存ゼロの静的サーバ
- three.js（0.170.0）は import map で jsDelivr から読む。デモにだけ許される依存で、`src/` には入れない
- **GLTFLoader の KHR_texture_transform は仕様とずれる**（S·R の順で合成するため、非一様 scale + rotation で崩れる）。
  `app.js` の `fixTextureTransforms()` で仕様どおりの行列に直してから左側に表示している
- **新しい USD 機能を出力したら、`usd-preview.js` / `checks.js` もそれを読めるように更新する**（例: 段階 3 の timeSamples、
  `UsdTransform2d` と `primvars:st1..3` は対応済み）

### 対応済み
- GLB ヘッダ / JSON / BIN チャンク、`data:` URI のバッファと画像
- `.gltf`（JSON テキスト / オブジェクト）と外部 `.bin`・画像（`options.resources`。uri そのまま → percent-decode → ファイル名だけ、の順で探す。
  見つからないバッファは throw、画像は警告してテクスチャなし。mimeType がない画像はマジックバイトで PNG / JPEG 判定）
- ノード階層 → `Xform`、TRS または `matrix` → `xformOp:transform`
- TRIANGLES / STRIP / FAN、インデックス有無
- POSITION / NORMAL / TEXCOORD_0（V 反転）/ COLOR_0（`primvars:displayColor`）
- `extent`、`prepend apiSchemas = ["MaterialBindingAPI"]`、`doubleSided`
- マテリアル: baseColor factor/texture、metallicRoughness、normal、occlusion、emissive、alphaMode BLEND/MASK
- テクスチャ（PNG / JPEG）の USDZ 同梱（`textures/<name>.<ext>`、同名は `<name>_1.<ext>`）
- sampler の wrapS / wrapT
- TEXCOORD_n → `primvars:st` / `st1` / `st2` …、テクスチャの `texCoord` ごとに `uvReader_st<n>`
- KHR_texture_transform → `Transform2d_<slot>`（`UsdTransform2d`）。`texCoord` の上書きにも対応
- 複数ノードで共有されるメッシュ → `class Xform "Meshes"` 下のプロトタイプ + `instanceable` な internal reference
- KHR_materials_emissive_strength（emissiveColor に乗算）、KHR_materials_ior（`inputs:ior`）、
  KHR_materials_clearcoat（`inputs:clearcoat` / `clearcoatRoughness`、テクスチャは R / G。clearcoatNormal は警告）
- `options.onWarning`: 未対応拡張、POINTS / LINES、POSITION なし、アニメーション / スキン / カメラ / モーフ、複数シーン、
  解決できない画像、PNG / JPEG 以外の画像、マテリアルが使う TEXCOORD_n が Mesh にない

### 未対応（既知）
- KHR_materials_transmission / volume / specular / sheen / unlit など（警告）、KHR_mesh_quantization（normalized は読めるので一部は動く）
- POINTS / LINES プリミティブ（スキップして警告）
- アニメーション、スキン、モーフターゲット、カメラ、ライト
- USDC（Crate）出力

## 重要な設計判断（変えるときは理由を README にも書くこと）

1. **glTF → USD IR → テキストの 2 段構成。**（段階 3 の頭で分割済み。分割前後で全サンプルの出力がバイト単位で一致することを確認）
   `convert.js` は USD の書式を知らず、`usda.js` は glTF を知らない。USDC writer（段階 5）も同じ IR から書く。
   IR の値はフラットな配列（タプルも平坦化）、型は `typeName` 文字列で持つ。
2. **座標変換はしない。** glTF と USD は両方 Y-up・右手系・メートル。UV の V だけ `1 - v` で反転する。
3. **行列はそのまま書く。** glTF の column-major 16 要素を 4 要素ずつ 4 行で書くと USD の row-vector 規約に一致する
   （平行移動が最終行）。転置してはいけない。
4. **metallicRoughness テクスチャ**は G=roughness, B=metallic。`UsdUVTexture.outputs:g` / `outputs:b` に接続し、
   factor は `inputs:scale = (1, roughness, metallic, 1)` で乗算。
5. **法線マップ**は `inputs:scale = (2,2,2,1)`, `inputs:bias = (-1,-1,-1,0)`、`sourceColorSpace = "raw"`。
6. **USDZ** は圧縮禁止、各エントリのデータ先頭が 64 バイト境界、最初のエントリがルートレイヤ。
   パディングは zip の extra field（header id 0x1986）で行う。パディングが 1〜3 バイトになる場合は 64 を足す。
7. **prim 名**は `[A-Za-z_][A-Za-z0-9_]*` に `sanitize()` し、兄弟間で `uniqueName()` で重複回避。
   マテリアル名は Mesh が先に参照するため `uniqueMaterialName()` でキャッシュして決定的に生成する。
8. **数値フォーマット**は `toPrecision(7)` 経由（float 精度相当、ファイルサイズ抑制）。
9. **KHR_texture_transform** は glTF の V 下向き空間で `uv' = T·R·S·uv`（R = [[cos, sin], [-sin, cos]]）。
   USD の st = (u, 1-v) に書き直すと `UsdTransform2d` そのもの（scale → 反時計回り rotation [度] → translation）になり、
   `translation = (offset.x + sin·scale.y, 1 - offset.y - cos·scale.y)`。導出は `textureTransform()` のコメント参照。
10. **instancing のプロトタイプは `class` の下に置く。** `def` だと原点にもう 1 つ描画されてしまう。
   プロトタイプ内の `material:binding` は外の `/Root/Materials/...` を指したままでよい（internal reference なので
   OpenUSD で instance proxy から `ComputeBoundMaterial()` が解決できることを確認済み）。
   Mesh prim と子ノードは同じ Xform の下で名前空間を共有するので、1 つの `names` セットで `uniqueName()` する。

## OpenUSD バリデータに指摘されて直した点（再発注意）

- `UsdPrimvarReader_float2` の `inputs:varname` は **`string`**（`token` だと MismatchedPropertyType）
- `material:binding` を持つ prim には **`prepend apiSchemas = ["MaterialBindingAPI"]`** が必須
- `extent` がないと USDZ 系チェックで警告

## 検証手順（変更のたびに必ず実行）

```bash
npm test                                   # GLB 生成 + JS テスト
node cli.js test/cube.glb /tmp/cube.usdz
pip install usd-core --break-system-packages   # 初回のみ
python3 test/validate.py /tmp/cube.usdz    # "0 validation error(s)" を確認
node cli.js test/features.glb /tmp/features.usdz && python3 test/validate.py /tmp/features.usdz
node cli.js test/gltf/cube.gltf /tmp/cube-gltf.usdz && python3 test/validate.py /tmp/cube-gltf.usdz
npm run demo                               # 見た目の確認: サンプルと fixtures の GLB を左右で比較
```

実物の GLB で確認したい場合は Khronos の glTF-Sample-Assets（Apache 2.0 / CC 系）から
`Box.glb`, `BoxTextured.glb`, `DamagedHelmet.glb`, `CesiumMilkTruck.glb`（複数ノード・共有メッシュ）,
`RiggedSimple.glb`（スキン）, `AnimatedCube.glb` あたりを `test/fixtures/` に置いて試す（リポジトリにはコミットしない）。

## ロードマップと次のタスク

### 段階 2: 幾何・マテリアルの網羅性
- [x] 共有メッシュの instancing: `/Root/Meshes/<Mesh>` に実体を置き、ノード側は `references` + `instanceable = true`
      （glTF の `mesh` が複数ノードから参照される場合のみ。`options.instancing: false` で従来どおり複製）
- [x] TEXCOORD_1 → `primvars:st1`、`texCoord` フィールドを見てテクスチャごとに `uvReader_st1` を使う（TEXCOORD_n 全般）
- [x] KHR_texture_transform → `UsdTransform2d` シェーダを `uvReader` と `UsdUVTexture` の間に挟む
- [x] KHR_materials_emissive_strength / ior / clearcoat（UsdPreviewSurface に対応する入力があるもののみ）
- [ ] KHR_materials_transmission: UsdPreviewSurface に対応入力がないので現状は警告のみ。`opacity = 1 - transmission` で
      近似するかは要相談（ガラスが消えて見える副作用がある）
- [x] sampler の wrapS/wrapT（REPEAT / CLAMP_TO_EDGE / MIRRORED_REPEAT → `repeat` / `clamp` / `mirror`）
- [x] 外部 `.gltf` 入力（`options.resources` = Map / object / `(uri) => bytes`。CLI は隣接ファイル、デモは複数ファイル選択）
- [x] 画像名の衝突回避（同名画像が複数ある場合）。大文字小文字を区別せずに比較
- [x] `options.onWarning`（`ctx.warn()`、同じ文言は 1 回だけ）。対応した拡張は `SUPPORTED_EXTENSIONS` に追加すること

### 段階 3: アニメーション
- [ ] `timeSamples` で `xformOp:translate` / `xformOp:orient` / `xformOp:scale` を別々に出す
      （アニメーション対象ノードは行列ではなく TRS 分解形式で書く）
- [ ] レイヤメタデータに `startTimeCode` / `endTimeCode` / `timeCodesPerSecond = 24`（glTF は秒単位なので変換）
- [ ] 補間: LINEAR はそのまま、STEP は `interpolation = "held"`、CUBICSPLINE はサンプリングしてベイク
- [ ] 複数アニメーションは最初の 1 本を書く（USD は 1 タイムラインのみ）。残りは `variantSet` で切替可能にするかは要相談

### 段階 4: スキン・モーフ
- [ ] UsdSkel: `SkelRoot` / `Skeleton`（joints, bindTransforms, restTransforms）/ `SkelAnimation` / `SkelBindingAPI`
      Mesh 側に `primvars:skel:jointIndices` / `jointWeights`（elementSize = 4）、`skel:geomBindTransform`
- [ ] モーフ: `BlendShape` prim（offsets / normalOffsets）+ `skel:blendShapes` + `SkelAnimation.blendShapeWeights`

### 段階 5: USDC (Crate) 出力
- OpenUSD `pxr/usd/usd/crateFile.cpp` / `crateData.cpp` が唯一の一次資料
- 最低限: Bootstrap ヘッダ、TOC、`TOKENS` / `STRINGS` / `FIELDS` / `FIELDSETS` / `PATHS` / `SPECS` セクション、
  インライン値 vs 参照値、配列の圧縮（整数配列は LZ4 + 差分圧縮。LZ4 も自前で書く必要あり）
- まず usda と同じ内容を usdc で出して `usdcat` で round-trip 比較する

## コーディング規約

- ESM、セミコロンあり、ダブルクォート、2 スペースインデント
- `src/` に外部依存を追加しない。どうしても必要なら理由を README に書く
- 新機能は `test/cube-glb.js` にケースを足すか `test/fixtures/` のサンプルで検証し、`validate.py` で error 0 を保つ
- 変換で捨てた情報（未対応拡張など）は `console.warn` ではなく `ctx.warn(msg)`（= `options.onWarning`）で通知する
- OpenUSD のコードを移植・翻訳した場合は、そのファイルに Pixar の著作権表示を残し、リポジトリに `THIRD_PARTY_NOTICES.md` を追加する
- 「OpenUSD」「Pixar」を名乗らない・公式と誤認させない
