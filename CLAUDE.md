# gltf2usd.js — 引き継ぎ書 / Claude Code 用コンテキスト

## プロジェクトの目的

GLB（glTF 2.0 binary）を USD（USDA / USDZ、将来 USDC）に変換する **依存ゼロの JavaScript ライブラリ**。
ブラウザと Node の両方で同じコードが動くこと（ESM、`ArrayBuffer` / `DataView` / `TextEncoder` のみ使用）が最重要の制約。
Node 固有 API（`fs`, `Buffer`）は `cli.js` と `test/` の中だけで使い、`src/` には持ち込まない。

npm パッケージ名: `gltf2usd-js`。

## 現在の状態（段階 1〜4 完了。要相談事項は「要相談」を参照）

`src/` 10 ファイル。テスト GLB（`cube.glb`、`features.glb`、`animated.glb`、`skinned.glb`、外部ファイル付き `gltf/cube.gltf`）と
Khronos サンプル（BoxTextured / CesiumMilkTruck / DamagedHelmet / BoxAnimated / InterpolationTest / RiggedSimple / RiggedFigure /
CesiumMan / Fox / AnimatedMorphCube / MorphPrimitivesTest）を OpenUSD 26.11 の全 30 バリデータに通して error 0 を確認済み。

| ファイル | 役割 | 備考 |
|---|---|---|
| `src/glb.js`  | `parseGLB()`, `GltfAsset` | accessor デコード（byteStride / normalized / sparse 対応）、`imageBytes()` |
| `src/convert.js` | `gltfToStage(asset, opts)` → `{ layer, files }`（glTF → USD IR） | ノード階層、Mesh、UsdPreviewSurface、警告 |
| `src/animation.js` | `evaluateAnimation(ctx, which)`, `sampleAt()` | glTF アニメーション 1 本 → ノードごとの TRS / weights サンプル |
| `src/skin.js` | `planSkins()`, `buildSkeleton()`, `skinningPrimvars()` | glTF skin → SkelRoot / Skeleton / SkelAnimation、jointIndices / Weights |
| `src/morph.js` | `addBlendShapes()`, `restWeights()` | morph target → BlendShape prim、skel:blendShapes |
| `src/math.js` | 4x4 行列（glTF 規約）、`decompose()`、`slerp()` | `composeTRS` もここ |
| `src/names.js` | `sanitize()`, `uniqueName()` | prim 名・ジョイント名 |
| `src/ir.js` | `Layer` / `Prim`（`attr()` / `rel()` / `child()`） | USD 側のプリム・属性ツリー。値の表現規約は冒頭コメント |
| `src/usda.js` | `writeUsda(layer)` → USDA 文字列 | 型名から書式を決める。timeSamples 対応 |
| `src/usdz.js` | `packUsdz(entries)` → `Uint8Array` | stored-only zip、64 バイトアライン、CRC32 自前 |
| `src/index.js`| `glbToUsda()`, `glbToUsdz()`, `gltfToUsda()` | 公開 API。名前は glb だが `.gltf` も受け付ける |
| `cli.js`      | `node cli.js in.glb\|in.gltf out.usdz\|out.usda` | `.gltf` の外部ファイルは同じフォルダ以下からのみ読む |
| `test/cube-glb.js` | テスト用 GLB をメモリ上で生成（Node / ブラウザ共用） | `buildCubeGlb()`（段階 1）、`buildFeatureGlb()`（段階 2）、`buildAnimatedGlb()`（段階 3）、`buildSkinnedGlb()`（段階 4）、`buildCubeGltf()` |
| `test/make-glb.js` | 上記を `test/*.glb` と `test/gltf/`（外部ファイル付き .gltf）に書き出す | |
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
- `checks.js`: 構造チェック（zip アライン / 圧縮 / CRC、Mesh トポロジ、primvar 要素数（elementSize 込み）、binding、シェーダ接続、
  テクスチャ参照、UsdSkel: SkelBindingAPI / SkelRoot 配下 / ジョイント順 / jointIndices の範囲 / BlendShape の要素数）
- `usdz-reader.js`: zip の central directory を読む
- `server.js`: 依存ゼロの静的サーバ
- three.js（0.170.0）は import map で jsDelivr から読む。デモにだけ許される依存で、`src/` には入れない
- **GLTFLoader の KHR_texture_transform は仕様とずれる**（S·R の順で合成するため、非一様 scale + rotation で崩れる）。
  `app.js` の `fixTextureTransforms()` で仕様どおりの行列に直してから左側に表示している
- **新しい USD 機能を出力したら、`usd-preview.js` / `checks.js` もそれを読めるように更新する**
  （`UsdTransform2d`、`primvars:st1..3`、internal reference、xformOp の timeSamples、UsdSkel は対応済み）
- UsdLux は DirectionalLight / PointLight / SpotLight（−Z 向き、強さはそのまま）で表示
- UsdSkel は `SkinnedMesh`（ボーンは Skeleton prim の親の下、boneInverses = inverse(bindTransforms)、bindMatrix = geomBindTransform、
  影響が 5 つ以上なら上位 4 つ）と morph 属性（`pointIndices` は全点に展開）で表示
- アニメーションがあると再生 / 一時停止とシークバーが出る。左は AnimationMixer（`LoopOnce` + 自前でループ）、
  右は timeSamples を USD と同じ規則（線形、quat は slerp、範囲外は端の値）で評価

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
- アニメーション（1 本）: translation / rotation / scale → `xformOp:translate` / `orient` / `scale` の timeSamples。
  LINEAR はそのまま、STEP は次キーの直前（-0.001 timecode）に同値を足して保持、CUBICSPLINE は 24fps + 全キーでベイク。
  `startTimeCode` / `endTimeCode` / `timeCodesPerSecond = framesPerSecond = 24`
- スキン → `/Root/Skins/<Skin>`（SkelRoot）に Skeleton / SkelAnimation / メッシュ。JOINTS_n / WEIGHTS_n すべて（elementSize = 4n）
- モーフターゲット → Mesh 子の `BlendShape`（offsets / normalOffsets、疎なら pointIndices）。スキンなしのメッシュは
  ノードの下に専用 SkelRoot（ジョイント 0 個の Skeleton）。ウェイトは node.weights / mesh.weights と weights アニメーション
- EXT_mesh_gpu_instancing → インスタンスごとに `xformOp:transform`（T·R·S）付きの Xform。メッシュのプロトタイプへの
  instanceable reference（`instancing: false` なら複製）。PointInstancer は AR Quick Look 等での対応が不確かなので使っていない。
  Khronos SimpleInstancing（125 個）で three.js の InstancedMesh とワールド行列が 5e-7 以内で一致
- KHR_lights_punctual → UsdLux（directional → DistantLight、point → SphereLight + treatAsPoint、spot → + ShapingAPI。
  強さは glTF の lux / candela をそのまま。UsdLux は単位を明示していないので近似。range は警告。AR Quick Look はライトを無視する）
- KHR_materials_unlit（近似: diffuseColor = 黒、baseColor → emissiveColor、`ior = 1` でフレネル反射を消す。他の PBR 入力は無視）
- KHR_mesh_quantization（整数・正規化 accessor + ノード変換。gltf-transform で量子化した DamagedHelmet / CesiumMan を
  three.js と比較して一致を確認）
- KHR_materials_emissive_strength（emissiveColor に乗算）、KHR_materials_ior（`inputs:ior`）、
  KHR_materials_clearcoat（`inputs:clearcoat` / `clearcoatRoughness`、テクスチャは R / G。clearcoatNormal は警告）
- `options.onWarning`: 未対応拡張、POINTS / LINES、POSITION なし、アニメーション / スキン / カメラ / モーフ、複数シーン、
  解決できない画像、PNG / JPEG 以外の画像、マテリアルが使う TEXCOORD_n が Mesh にない

### 未対応（既知）
- KHR_materials_transmission / volume / specular / sheen など（警告）
- KHR_draco_mesh_compression: 非圧縮の fallback があればそれを使う。なければそのプリミティブをスキップして警告
- EXT_meshopt_compression: 未デコード。fallback バッファしかない bufferView を読むと `DataUnavailableError` になり、
  メッシュ / アニメーションのチャンネル / スキンの単位でスキップして警告（以前のように 0 埋めで壊れたメッシュは出さない）
- POINTS / LINES プリミティブ（スキップして警告）
- 2 本目以降のアニメーション（`options.animation` で 1 本選ぶ。警告あり）
- ジョイントの間にある非ジョイントノードのアニメーション（警告）、morph target の TANGENT（警告）
- カメラ
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
11. **アニメーションの補間。** USD には保存できる補間モードがない（held / linear はステージの実行時設定）。
   LINEAR はキーをそのまま書く（ベクトルは線形、`quatf` は OpenUSD が最短経路 slerp することを確認済み）。
   STEP は各キーの値を次キーの 0.001 timecode 手前にも書いて保持する。CUBICSPLINE はフレームごと + 全キーで Hermite 評価して
   ベイクする（回転は正規化）。three.js の AnimationMixer と OpenUSD の評価を比較して、LINEAR / STEP は 1e-6 以内、
   CUBICSPLINE はフレーム間で最大 3e-3（24fps ベイクによる誤差）。

12. **UsdSkel の配置。** glTF はスキンメッシュのノード変換を無視し `Σ w · jointWorld · IBM · v`（ワールド）で変形する。
   そこで各スキンを単位変換の `/Root/Skins/<Skin>`（SkelRoot）に置き、スケルトン空間 = glTF のワールドにする。
   `bindTransforms = inverse(IBM)`、`geomBindTransform = 単位`。ジョイントの親は「同じスキンの最も近い祖先ジョイント」、
   `restTransforms` とアニメーションは `inverse(world(親ジョイント)) · world(直接の親) · local(t)`（ルートは祖先の Armature 等も含む）。
   前置行列が単位なら TRS をそのまま、そうでなければ分解して書く。joints は親が先（UsdSkel の要件）。
   ジョイントのノード自体も Scene に Xform として残る（ボーンに付けた小物はそのまま動く）。
   スキン / モーフ付きメッシュは instancing しない（ノードごとにバインドが違うため）。
13. **BlendShape はジョイント 0 個の Skeleton でも動く**（OpenUSD で確認済み）。トークンは `<Mesh prim>_<target>` にして、
   1 つの SkelAnimation を複数メッシュで共有できるようにする。three.js（getVertexPosition）と OpenUSD（UsdSkel の
   BlendShapeQuery + SkinningQuery）の変形後頂点を比較して、RiggedSimple / RiggedFigure / CesiumMan / Fox / AnimatedMorphCube /
   MorphPrimitivesTest / skinned.glb で相対 1e-6 以内。

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
node cli.js test/animated.glb /tmp/animated.usdz && python3 test/validate.py /tmp/animated.usdz
node cli.js test/skinned.glb /tmp/skinned.usdz && python3 test/validate.py /tmp/skinned.usdz
node cli.js test/features.glb /tmp/features.usdz && python3 test/validate.py /tmp/features.usdz
node cli.js test/gltf/cube.gltf /tmp/cube-gltf.usdz && python3 test/validate.py /tmp/cube-gltf.usdz
npm run demo                               # 見た目の確認: サンプルと fixtures の GLB を左右で比較
```

実物の GLB で確認したい場合は Khronos の glTF-Sample-Assets（Apache 2.0 / CC 系）から
`Box.glb`, `BoxTextured.glb`, `DamagedHelmet.glb`, `CesiumMilkTruck.glb`（複数ノード・共有メッシュ）,
`RiggedSimple.glb`（スキン）, `AnimatedCube.glb` あたりを `test/fixtures/` に置いて試す（リポジトリにはコミットしない）。

## 要相談（ユーザー判断待ち）

- **KHR_materials_transmission**: UsdPreviewSurface に対応入力がない。現状は警告のみ。`opacity = 1 - transmission` で近似するか
- **公開関数名**: `glbToUsda` / `glbToUsdz` は `.gltf` も受け付けるようになった。改名や別名を足すか
- **複数アニメーション**: 現状は 1 本（`options.animation`）。`variantSet` で切替にするか、別ノードを動かすクリップは統合するか
  （例: Khronos の InterpolationTest は 9 クリップがそれぞれ別のキューブを動かすので、統合すれば全部入る。Fox は Survey / Walk / Run）
- **CUBICSPLINE のベイク間隔**: 24fps で最大 3e-3 の誤差。もっと細かくするか
- **マテリアルなしのプリミティブ**: glTF の既定マテリアル（白、metallic 1、roughness 1）を書いていない。USD 側では未バインド扱いで
  灰色に見える（段階 1 からの挙動）。既定マテリアルを出力するか

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
- [x] `timeSamples` で `xformOp:translate` / `xformOp:orient` / `xformOp:scale` を別々に出す
      （アニメーション対象ノードは行列ではなく TRS 分解形式で書く）
- [x] レイヤメタデータに `startTimeCode` / `endTimeCode` / `timeCodesPerSecond = 24`（glTF は秒単位なので変換）
- [x] 補間: LINEAR はそのまま、STEP は保持サンプルを追加してベイク、CUBICSPLINE はサンプリングしてベイク
      （当初案の `interpolation = "held"` はレイヤに書けない。OpenUSD は黙って捨てて線形補間する。下記の設計判断 11）
- [x] 複数アニメーションは 1 本だけ書く（既定は最初、`options.animation` で index か名前を指定）。残りは警告
- [ ] 残り（`variantSet` で切替 / 衝突しないクリップの統合）をどうするかは要相談

### 段階 4: スキン・モーフ
- [x] UsdSkel: `SkelRoot` / `Skeleton`（joints, bindTransforms, restTransforms）/ `SkelAnimation` / `SkelBindingAPI`
      Mesh 側に `primvars:skel:jointIndices` / `jointWeights`（elementSize = 4 × セット数）、`skel:geomBindTransform`
- [x] モーフ: `BlendShape` prim（offsets / normalOffsets / pointIndices）+ `skel:blendShapes` + `SkelAnimation.blendShapeWeights`

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
