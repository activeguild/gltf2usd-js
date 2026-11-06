# gltf2usd.js — 引き継ぎ書 / Claude Code 用コンテキスト

## プロジェクトの目的

GLB（glTF 2.0 binary）を USD（USDA / USDZ、将来 USDC）に変換する **依存ゼロの JavaScript ライブラリ**。
ブラウザと Node の両方で同じコードが動くこと（ESM、`ArrayBuffer` / `DataView` / `TextEncoder` のみ使用）が最重要の制約。
Node 固有 API（`fs`, `Buffer`）は `cli.js` と `test/` の中だけで使い、`src/` には持ち込まない。

npm パッケージ名: `gltf2usd-js`。

## 現在の状態（段階 1〜4 完了。要相談事項は「要相談」を参照）

`src/` 14 ファイル + 型定義 `index.d.ts`。テスト GLB（`cube.glb`、`features.glb`、`animated.glb`、`skinned.glb`、外部ファイル付き `gltf/cube.gltf`）と
Khronos サンプル（BoxTextured / CesiumMilkTruck / DamagedHelmet / BoxAnimated / InterpolationTest / RiggedSimple / RiggedFigure /
CesiumMan / Fox / AnimatedMorphCube / MorphPrimitivesTest と、glTF-Draco 版のある 16 モデルすべて）を OpenUSD 26.11 の
全 30 バリデータに通して error 0 を確認済み。

| ファイル | 役割 | 備考 |
|---|---|---|
| `src/glb.js`  | `parseGLB()`, `GltfAsset` | GLB ヘッダ / チャンクの検証、accessor デコード（byteStride / normalized / sparse / 行列の列パディング）、`imageBytes()` |
| `src/validate.js` | `validateDocument()`, `GltfValidationError`, `DEFAULT_LIMITS`, `elementLayout()` | 変換前の構造検証（参照・バイト範囲・ノード階層・スキン・アニメーション）とリソース上限 |
| `src/convert.js` | `gltfToStage(asset, opts)` → `{ layer, files }`（glTF → USD IR） | ノード階層、Mesh、UsdPreviewSurface、警告 |
| `src/animation.js` | `evaluateAnimation(ctx, which)`, `sampleAt()` | glTF アニメーション 1 本 → ノードごとの TRS / weights サンプル |
| `src/skin.js` | `planSkins()`, `buildSkeleton()`, `skinningPrimvars()` | glTF skin → SkelRoot / Skeleton / SkelAnimation、jointIndices / Weights |
| `src/morph.js` | `addBlendShapes()`, `restWeights()` | morph target → BlendShape prim、skel:blendShapes |
| `src/meshopt.js` | `decodeMeshopt(source, ext)` | EXT_meshopt_compression の ATTRIBUTES / TRIANGLES / INDICES と 3 フィルタ |
| `src/draco.js` | `decodeDracoMesh(bytes, { maxValues })`, `DracoError` | KHR_draco_mesh_compression（Draco ビットストリーム 2.2 の三角形メッシュ）。設計判断 23 |
| `src/math.js` | 4x4 行列（glTF 規約）、`decompose()`、`slerp()` | `composeTRS` もここ |
| `src/names.js` | `sanitize()`, `uniqueName()` | prim 名・ジョイント名 |
| `src/ir.js` | `Layer` / `Prim`（`attr()` / `rel()` / `child()`） | USD 側のプリム・属性ツリー。値の表現規約は冒頭コメント |
| `src/usda.js` | `writeUsda(layer)` → USDA 文字列 | 型名から書式を決める。timeSamples 対応 |
| `src/images.js` | `imagesToConvert()`, `browserImageConverter()` | USDZ に入れられない画像（WebP）の変換。非同期 API（`glbToUsdzAsync`）から使う |
| `src/png.js` | `encodeGrayAlphaPng()` | 変換器が自分で作るテクスチャ（頂点アルファのランプ）用の小さな PNG 書き出し |
| `src/usdz.js` | `packUsdz(entries)` → `Uint8Array`、`planLayout()`、`UsdzLimitError` | stored-only zip、64 バイトアライン、CRC32 自前。ZIP の上限とエントリ名を書く前に検査 |
| `src/index.d.ts` | 公開 API の型定義（手書き） | `src/index.js` の export を変えたら必ず合わせる。export 名の一致は `test/run.js`、型は `npm run test:types`（`test/types.ts`） |
| `src/index.js`| `toUsda()`, `toUsdz()`, `toUsdaAsync()`, `toUsdzAsync()`, `gltfToUsda()` | 公開 API。GLB と `.gltf` を受け付ける。旧名 `glbToUsda` などは同じ関数の別名（設計判断 24）。Async 版は WebP などの画像を変換してから変換する |
| `cli.js`      | `node cli.js in.glb\|in.gltf out.usdz\|out.usda`（`--help` / `--version`） | `.gltf` の外部ファイルは同じフォルダ以下からのみ読む。npm の bin は `glb2usd` |
| `test/cube-glb.js` | テスト用 GLB をメモリ上で生成（Node / ブラウザ共用） | `buildCubeGlb()`（段階 1）、`buildFeatureGlb()`（段階 2）、`buildAnimatedGlb()`（段階 3）、`buildSkinnedGlb()`（段階 4）、`buildCubeGltf()` |
| `test/make-glb.js` | 上記を `test/*.glb` と `test/gltf/`（外部ファイル付き .gltf）に書き出す | |
| `test/png.js` | テスト画像用の小さな PNG エンコーダ | |
| `test/meshopt-vectors.js` | meshopt のテストベクトル（meshoptimizer のエンコーダで生成した入力とリファレンス出力） | 依存なしでデコーダを検証するため |
| `test/draco-vectors.js` / `make-draco-vectors.js` | Draco のテストベクトル（draco3d 1.5.9 で圧縮した 7 本と draco3d の復元結果の CRC32）と、その生成スクリプト | 生成は `npm install --no-save draco3d@1.5.9` のうえ手で実行。`--compare N` でランダム比較 |
| `test/draco.js` | Draco: ベクトルとの一致、壊れた入力が `DracoError` になること、glTF 側（accessor の充填・型変換・検証） | `npm test`（ブラウザでも動く） |
| `test/run.js` | JS 側の単体テスト（prim 名、zip アライン検証） | `npm test` |
| `test/validation.js` / `accessor.js` / `color.js` / `usdz.js` / `edge-cases.js` | 入力検証、行列 accessor、頂点カラー / アルファ、USDZ の上限、アニメーション / スキンの境界値 | `npm test`（`usdz.js` 以外はブラウザでも動く。`images.js` も） |
| `test/images.js` | WebP 画像の扱い（同期版は警告、非同期版は `convertImage` で変換） | `npm test` |
| `test/gltf-builder.js` | テスト用に glTF / GLB を組み立てる小さなヘルパ | |
| `test/integration/` | Khronos glTF-Sample-Assets（コミット固定、SHA-256 照合）の 22 モデルで変換・zip・内容・OpenUSD 検証 | `npm run test:integration`（ネットワーク。`-- --offline` でキャッシュのみ） |
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
- 左の GLTFLoader には three.js の MeshoptDecoder と DRACOLoader（Google の WASM デコーダ、同じ three.js 0.170.0 の
  `examples/jsm/libs/draco/gltf/`）を渡している。右（変換結果）は `src/meshopt.js` / `src/draco.js` を使うので、左右の比較が検証になる
- **GLTFLoader の KHR_texture_transform は仕様とずれる**（S·R の順で合成するため、非一様 scale + rotation で崩れる）。
  `app.js` の `fixTextureTransforms()` で仕様どおりの行列に直してから左側に表示している
- **新しい USD 機能を出力したら、`usd-preview.js` / `checks.js` もそれを読めるように更新する**
  （`UsdTransform2d`、`primvars:st1..3`、internal reference、xformOp の timeSamples、UsdSkel は対応済み）
- variantSet があると選択 UI が出る。右は選択した variant の opinion を合成して再構築、左は GLTFLoader の parser で
  KHR_materials_variants の対応どおりにマテリアルを差し替える（option の順 = default + glTF の順）
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
- glTF の既定: NORMAL がなければ flat normals（faceVarying）、マテリアルがなければ `DefaultMaterial`（白、metallic 1、roughness 1。
  COLOR_0 があるときは displayColor を活かすため付けない）。`/Root` に `kind = "component"`
- マテリアル: baseColor factor/texture、metallicRoughness、normal、occlusion、emissive、alphaMode BLEND/MASK
- テクスチャ（PNG / JPEG）の USDZ 同梱（`textures/<name>.<ext>`、同名は `<name>_1.<ext>`）
- sampler の wrapS / wrapT
- TEXCOORD_n → `primvars:st` / `st1` / `st2` …、テクスチャの `texCoord` ごとに `uvReader_st<n>`
- KHR_texture_transform → `Transform2d_<slot>`（`UsdTransform2d`）。`texCoord` の上書きにも対応
- 複数ノードで共有されるメッシュ → `class Xform "Meshes"` 下のプロトタイプ + `instanceable` な internal reference
- **ノードアニメーションは既定でスケルトンに変換**（`animationMode: "skeleton"`）: 動くノードとその子孫を 1 つの Skeleton の
  ジョイントにし、`/Root/Animated` にメッシュを移して該当ジョイントに剛体バインド（頂点ごとの jointIndices / weights、
  geomBind = ノードの rest ワールド行列）。下記の設計判断 16, 17
- `animationMode: "xform"` のときのアニメーション（1 本）: translation / rotation / scale → `xformOp:translate` / `orient` / `scale` の timeSamples。
  LINEAR はそのまま、STEP は次キーの直前（-0.001 timecode）に同値を足して保持、CUBICSPLINE は 24fps + 全キーでベイク。
  `startTimeCode` / `endTimeCode` / `timeCodesPerSecond = framesPerSecond = 24`
- スキン → `/Root/Skins/Skin_<Skin>`（Xform。`/Root` が SkelRoot）に Skeleton（子に SkelAnimation）/ メッシュ。JOINTS_n / WEIGHTS_n すべて（elementSize = 4n）
- モーフターゲット → Mesh 子の `BlendShape`（offsets / normalOffsets、疎なら pointIndices）。スキンなしのメッシュは
  ノードの下に専用 SkelRoot（ジョイント 0 個の Skeleton）。ウェイトは node.weights / mesh.weights と weights アニメーション
- EXT_mesh_gpu_instancing → インスタンスごとに `xformOp:transform`（T·R·S）付きの Xform（独自属性は警告して無視）。メッシュのプロトタイプへの
  instanceable reference（`instancing: false` なら複製）。PointInstancer は AR Quick Look 等での対応が不確かなので使っていない。
  Khronos SimpleInstancing（125 個）で three.js の InstancedMesh とワールド行列が 5e-7 以内で一致
- KHR_materials_variants → `/Root` の variantSet `materialVariant`（`default` + glTF の各バリアント、既定の選択は `default`）。
  各 variant に `over` で Mesh の `material:binding`（対応がなければ既定マテリアル）。インスタンス化メッシュはプロトタイプを上書き
- KHR_lights_punctual → UsdLux（directional → DistantLight、point → SphereLight + treatAsPoint、spot → + ShapingAPI。
  強さは glTF の lux / candela をそのまま。UsdLux は単位を明示していないので近似。range は警告。AR Quick Look はライトを無視する）
- KHR_materials_unlit（近似: diffuseColor = 黒、baseColor → emissiveColor、`ior = 1` でフレネル反射を消す。他の PBR 入力は無視）
- EXT_meshopt_compression（`src/meshopt.js`。全モード・全フィルタ。bufferView 単位でデコードしてキャッシュ）
- KHR_draco_mesh_compression（`src/draco.js`。ビットストリーム 2.2 のシーケンシャル / エッジブレイカー（標準・valence）、全予測方式。
  bufferView 単位でデコードしてキャッシュ。設計判断 23）
- KHR_mesh_quantization（整数・正規化 accessor + ノード変換。gltf-transform で量子化した DamagedHelmet / CesiumMan を
  three.js と比較して一致を確認）
- KHR_materials_emissive_strength（emissiveColor に乗算）、KHR_materials_ior（`inputs:ior`）、
  KHR_materials_clearcoat（`inputs:clearcoat` / `clearcoatRoughness`、テクスチャは R / G。clearcoatNormal は警告）
- `options.onWarning`: 未対応拡張、POINTS / LINES、アニメーション / スキン / カメラ / モーフ、複数シーン、
  解決できない画像、PNG / JPEG 以外の画像、マテリアルが使う TEXCOORD_n が Mesh にない
- 入力検証（設計判断 19）: 不正な入力は `GltfValidationError`。`options.limits`（既定は `DEFAULT_LIMITS`）
- COLOR_0 の VEC4 アルファ → BLEND / MASK のマテリアルでアルファのランプ画像 + `primvars:vertexAlphaUV`（設計判断 20）
- 行列 accessor（MAT2 / MAT3）の列ごとの 4 バイト境界
- USDZ の ZIP 上限（設計判断 21）。超える場合は `UsdzLimitError`
- EXT_texture_webp（設計判断 22）: `glbToUsdzAsync` が WebP を PNG / JPEG に変換。デモはこちらを使う

### 未対応（既知）
- マテリアルがあるメッシュの頂点カラー RGB（`displayColor` は書くがマテリアルに掛けない。glTF は baseColor に掛ける）
- 頂点アルファ × baseColorTexture のアルファ（UsdPreviewSurface では掛けられない。テクスチャのアルファを使い警告）
- KHR_meshopt_compression（EXT_ 版とはバージョン・フィルタが違う。fallback buffer を読めないものとして扱い、該当メッシュをスキップして警告）
- ZIP64（4 GiB を超える USDZ は `UsdzLimitError`）
- KHR_materials_transmission / volume / specular / sheen など（警告）
- Draco のビットストリーム 2.2 以外（KHR_draco_mesh_compression が 2.2 を規定しているので、glTF では出てこないはず）
- 読めないデータ（デコードできない Draco で fallback がない、壊れた meshopt 列など）は `DataUnavailableError` になり、
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
   出力の定義は `Number(v.toPrecision(7)).toString()` のまま（`fmtSlow()`）で、1e-4 ≤ |v| < 1e7 は整数演算の高速経路
   （`fastFmt()`、丸めが 0.5 付近・桁数の判定ずれは `fmtSlow()` に戻す）。大きな配列は数 KB ごとの文字列チャンクで組み立て、CRC32 は slice-by-8。
   USDA の生成が全体の 6〜8 割を占めていたため。変更前後で fixtures と Khronos サンプル（27 入力 × animationMode 2 通り）の USDZ が
   バイト単位で一致し、全体で 1.3〜1.8 倍速い（DamagedHelmet 105 → 60 ms、BrainStem-meshopt 480 → 345 ms）。`test/run.js` で旧定義と照合している。
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
14. **material variants では、対象 Mesh に binding を直接書かない。** USD の強さは LIVRPS で Local > Variant なので、
   直接書くとどの variant でも上書きできない（OpenUSD で確認して判明）。代わりに `default` variant に既定マテリアルを入れて
   選択しておく（glTF の「未選択」に相当）。各 variant は「対応付けがあればそのマテリアル、なければ既定マテリアル」。
15. **meshopt デコーダは仕様のビット列から独立実装**（ライブラリのコードは移植していない）。meshoptimizer のスカラー版デコーダと、
   gltf-transform で圧縮した 6 ファイルの全 55 bufferView、およびエンコーダを使ったランダムテスト 81 ケースでバイト一致。
   QUATERNION フィルタは float32 で計算（`Math.fround`）し、.5 ちょうどは 0 から遠い側へ丸める（スカラー版と同じ）。
   SIMD 版（three.js が使う）は偶数丸めなので、ちょうど .5 の値だけ int16 で 1 違う（表示上は無関係）。
16. **ノードアニメーションは UsdSkel で書く（既定）。** ユーザーの実機ビューア（AR Quick Look 系）で、xformOp の timeSamples は
   どの書き方（double/float、行列、instancing の有無、USDC）でも再生されず、同じ動きを剛体スケルトンにしたものは再生された。
   Apple の見本（toy_drummer / hummingbird）もスケルトンのみ。usdzconvert の `bindRigidDeformation` と同じ方式
   （ただし usdzconvert 自身はノードアニメーションを xformOp で書いている）。OpenUSD 上はどちらも正しく評価される。
   three.js と OpenUSD の頂点比較で animated.glb / BoxAnimated / CesiumMilkTruck / InterpolationTest が一致（CUBICSPLINE 以外 1e-5 以内）。
17. **スケルトンがあれば `/Root` 自体を SkelRoot にする。** 確認ビューアは **Mac の Finder の Quick Look（スペースキー）**。
   SkelRoot を `/Root`（Xform）の下に入れ子にした出力は USDA / USDC とも再生されず、defaultPrim が SkelRoot の構成だけ再生された
   （USDA でも再生される＝形式は無関係）。各スケルトンの入れ物は Xform、SkelAnimation は Skeleton の子、剛体バインドの
   jointIndices / Weights は頂点ごと。Apple の見本（toy_drummer / hummingbird）と同じ構成で、hummingbird は 1 つの SkelRoot に
   Skeleton が 2 つある。
18. **スキンの入れ物の名前は常に `Skin_` を付ける。** Mac の Quick Look は、Skeleton を入れた Xform の名前が `Rig` だと
   スキンを再生しなかった（データも構成も同じまま、その prim の名前だけ `Armature` / `Body` に変えると再生された）。
   同じ名前をメッシュや `/Root/Scene` のノードに付けても問題はない。ほかに再生を妨げる名前があるかは不明なので、glTF のスキン名は
   そのまま使わない。各頂点のウェイトを重い順に並べるのは、この調査の途中で入れた変更で、Quick Look の再生には無関係だった
   （変形は変わらないので残している）。
   この 16〜18 の出力（USDA ルートの USDZ）は、iOS の AR Quick Look でもスキン・ノードアニメーションとも再生されることを確認済み。
   Reality Converter だけはルートレイヤーが USDC でないと受け付けない（段階 5、issue #1）。
19. **入力は変換前に検証する（`src/validate.js`）。** データを読む・シーンをたどるのに使う参照とバイト範囲（buffer / bufferView /
   accessor / mesh / node / skin / animation）が不正なら `GltfValidationError`（何番の何が不正かを書く）。0 埋め・切り詰めで続けない。
   マテリアル / テクスチャ / 画像 / ライト / バリアントの不正な参照は従来どおり無視して警告（見た目のデータで、無くても形は正しい）。
   GLB は totalLength = 入力サイズ、チャンク長は 4 の倍数、JSON が先頭で 1 つ、BIN は 2 番目で 1 つまで、未知のチャンクは読み飛ばす。
   アライメント（§ 3.6.2.4 / § 3.7.2.1）: accessor の byteOffset と bufferView.byteOffset + accessor.byteOffset は componentType の
   バイト数の倍数、頂点属性（morph target を含む）の byteOffset は 4 の倍数。インデックス / inverseBindMatrices / アニメーションの
   accessor は byteStride 付きの bufferView を使えない。sparse の indices / values の bufferView は byteStride・target なし、
   bufferView.byteOffset と indices / values の byteOffset はそれぞれの componentType のバイト数の倍数。
   （以前は「DataView で読めるので拒否しない」としていたが、指示により仕様どおり拒否する。既存 26 フィクスチャ・Khronos 19 モデル・
   gltf-transform の meshopt / 量子化出力で誤検出がないことを確認済み。）
   アニメーションのキーが壊れたチャンネル（時刻が減る、NaN / Infinity、個数が合わない）は警告してスキップ。同時刻のキーは最後を残す。
   JOINTS の範囲外（ウェイト > 0）・負 / NaN のウェイトはエラー、ウェイトの合計が 1 でない頂点は警告してそのまま書く。
   Mesh: primitive の全属性（標準も `_NAME` の独自属性も例外なし）と morph target の要素数は POSITION と同じ（§ 3.7.2.1）。
   TEXCOORD_n / COLOR_n / JOINTS_n / WEIGHTS_n の n は 0 か先頭ゼロなしの 1〜999999999（9 桁まで）で、0 から欠けなく連続（`setsOf()`）。
   accessor の count は 1 以上の整数（0・負数・小数・文字列・null は不可。使われない accessor も含む）。
   インデックスは SCALAR・5121/5123/5125・normalized なし。mode は 0..6（省略時 4）で、インデックス数（なければ頂点数）は
   POINTS ≥ 1、LINES ≥ 2 かつ偶数、LINE_LOOP / LINE_STRIP ≥ 2、TRIANGLES ≥ 3 かつ 3 の倍数、TRIANGLE_STRIP / FAN ≥ 3（`MODE_RULES`）。
   インデックスの値は componentType の最大値（255 / 65535 / 4294967295、予約値）でなく、POSITION の数未満。値はデコード後でないと
   分からない（sparse / meshopt）ので `checkIndexValues()` を `buildTriangleIndices()` から呼ぶ。変換しない POINTS / LINES 系の
   primitive もインデックスを読んで同じ検査をする（出力は変わらない。インデックスのない primitive には予約値の検査はない）。
   属性の type / componentType は glTF 2.0 § 3.7.2.1 どおり（POSITION / NORMAL VEC3、TANGENT VEC4、TEXCOORD_n VEC2、COLOR_n VEC3/VEC4、
   JOINTS_n / WEIGHTS_n VEC4。COLOR / WEIGHTS の整数は normalized の UNSIGNED_BYTE / SHORT のみ、JOINTS は normalized でない
   UNSIGNED_BYTE / SHORT のみ）。KHR_mesh_quantization の整数型は extensionsUsed にあるときだけ許す。morph target も同様（TANGENT は VEC3）。
   JOINTS_n と WEIGHTS_n は対で、番号は 0 から欠けなし。POSITION のない primitive はエラー（glTF の仕様上は「描かない」でよいが、
   変換するジオメトリがないので入力検証で止める。`buildMeshPrimData()` の警告とスキップは防御用に残している）。
   sparse / indices / values はオブジェクト、sparse の indices は GltfAsset の生成時に読んで、昇順・重複なし・count 未満を確認する
   （どこからも読まれない accessor でも検出する。meshopt で読めない view は読むときに確認）。
   以前は警告して正規化していた「normalized のない整数の COLOR_0」も、この規則でエラーになった。
   EXT_mesh_gpu_instancing: node.extensions / 拡張 / attributes はオブジェクト（attributes は必須で 1 つ以上、拡張を持つノードは mesh 必須）。TRANSLATION / SCALE は VEC3、
   ROTATION は VEC4。componentType は FLOAT（ROTATION は拡張の仕様どおり normalized BYTE / SHORT も可）。TRANSLATION / SCALE は
   KHR_mesh_quantization が宣言されていても FLOAT のみ（以前は整数を許していたが、指示により拡張の表どおりに絞った）。全属性の count は同じ（`gpuInstanceCount()` の `Math.min()` による切り詰めは廃止し、
   検証をすり抜けた不一致はエラー）。インスタンス属性の accessor の byteOffset は 4 の倍数（byteStride 付きの bufferView は可）。
   独自属性は名前が `_` で始まり UNSIGNED_INT でないこと（§ 3.7.2.1。それ以外の名前・型はエラー）。この規則は `checkAttribute()` に
   まとめ、mesh の attributes と GPU インスタンスの両方に適用（morph target の未知の名前は対象外）。mesh の `_ID` も UNSIGNED_INT は不可。
   accessor の `normalized` は boolean で、FLOAT / UNSIGNED_INT では true にできない（使われない accessor も含め全 accessor）。
   独自属性（`_ID` / `_COLOR` など）は参照・count・アライメントを検証したうえで USD には書かず、`warnCustomInstanceAttributes()` が
   ノードと属性ごとに 1 回警告する（インスタンス数は全属性共通の count のまま。独自属性だけならその count で恒等変換のインスタンス）。
   JSON の型: トップレベル配列の要素・primitive・target・sampler・channel はオブジェクト、children / scene.nodes / samplers / channels /
   primitives / targets は配列（標準の TypeError を出さない）。
   `DEFAULT_LIMITS` はメモリとスタックを守るためだけのもの（入力 2 GiB、accessor 1 本 2^26 値、ノードの深さ 1024 など）。
   `maxInputBytes` は GLB / glTF のバイト列、JSON 文字列（UTF-8 のバイト数）、`options.resources` の外部バッファそれぞれに適用。
   パース済みの glTF オブジェクトにはバイト数がないので対象外（ほかの上限は適用）。
   変更前後で 26 個のフィクスチャの出力がバイト単位で一致することを確認済み。
20. **頂点アルファはランプ画像 + 専用 UV で表す。** glTF はアルファ = factor.a × テクスチャ.a × COLOR_0.a で、BLEND / MASK のときだけ使う
   （OPAQUE・既定マテリアルは無視）。最初は `inputs:opacity` ← `UsdPrimvarReader_float`（`displayOpacity`）にしたが、**Quick Look は
   float / float3 の primvar reader を 0 として描く**（BLEND も MASK も消える。float3 で diffuse に繋ぐと黒）。UV の reader + テクスチャは、
   UV の名前が `st` 以外でも描ける（1 ファイルに 6 方式を並べて実機で確認）。そこで頂点アルファ付きで使われる BLEND / MASK マテリアル
   （ベースカラーテクスチャなし）は opacity を `Texture_vertexAlpha`（256 × 1 の gray+alpha ランプ `vertex_alpha_ramp.png`、
   `inputs:scale = (1,1,1,factor.a)`、clamp）の `a` から取り、メッシュには `primvars:vertexAlphaUV` = (テクセル中心の u = COLOR_0.a, 0.5) を書く。
   そのマテリアルに（variant 経由も含め）バインドされうるメッシュは全部この UV を持つ（なければ u = 1）。`displayOpacity` も記録として書く。
   ベースカラーテクスチャとの掛け合わせはできないのでテクスチャのアルファを使い警告。対象マテリアルは `planVertexAlpha()` で事前に決める。
   MASK は Quick Look がしきい値を超えた部分も中途半端な opacity で描いた（glTF では不透明）ので、MASK のマテリアルには
   COLOR_0.a = cutoff / factor.a で 0 → 1 に切り替わる階段のランプ（`vertex_alpha_step_<texel>.png`、scale 1）を使う。
   UsdUVTexture にはフィルタの指定がない（Nearest を指定できない）ので、線形補間で階段の 2 テクセルの間に中間の値が出る。
   その帯を狭くするため階段は 4096 テクセル（BLEND の 256 テクセルの 1/16 の幅）にし、帯の中央を cutoff / factor.a に合わせて
   `opacityThreshold = 0.5` で切る。`test/color.js` で線形補間を再現して、glTF の判定と食い違うのが切れ目の 1 テクセル以内だけであることを確認。
   iOS の Quick Look でも、アルファ 0.45 → 0.55 の横長の板（mask-edge.usdz）で、256 テクセルでは境目に見えた半透明の帯が 4096 テクセルでは見えないことを確認済み。
   BLEND のランプも MASK の階段も、iOS の Quick Look で glTF どおりに表示されることを確認済み（vertex-alpha.usdz の A / B / C）。
21. **USDZ の ZIP 上限は書く前に検査する。** `planLayout()` が長さだけから全オフセットを計算し、32 / 16 ビットのフィールドに収まらなければ
   `UsdzLimitError`（"USDZ exceeds supported ZIP size limits"）。エントリ名は相対・スラッシュ区切り・`.` `..` 空セグメントなし・
   大文字小文字を無視して一意、先頭は .usda / .usdc / .usd。出力バイトは変更前と同一。
22. **WebP は非同期 API で変換する。** USDZ は PNG / JPEG しか入れられない。WebP のデコードは依存ゼロでは重いので、
   `glbToUsdzAsync` / `glbToUsdaAsync` が `options.convertImage(bytes, mimeType)` で先に変換し、結果を `imageOverrides` として
   同期の変換に渡す（同期 API は従来どおり警告してテクスチャなし）。既定の変換はブラウザの `createImageBitmap` + `OffscreenCanvas`
   （透明な画素があれば PNG、なければ JPEG 品質 0.95。元の WebP が非可逆なので PNG にすると何倍も大きくなる）。
   Node には WebP デコーダがないので、`convertImage` を渡さない限り変換しない（CLI も同じ）。変換結果が PNG / JPEG でないか、
   失敗した画像は警告して捨てる。EXT_texture_webp の「未対応」警告は、WebP の画像がすべて変換できたときだけ出さない。
   ユーザー提供の Fox_optimized.glb（gltf-transform、1024² の非可逆 WebP、PNG の代替なし）で、Chromium での変換結果が
   OpenUSD のバリデータで error 0、デモの左右が一致。KTX2（KHR_texture_basisu）はブラウザでもデコードできないので対象外。
23. **Draco は自前のデコーダで読む（`src/draco.js`、issue #8 の案 2）。** KHR_draco_mesh_compression はビットストリーム 2.2 を規定するので
   2.2 だけを読む（それ以外は `DracoError`）。Draco の仕様書（google/draco の docs/spec）を基にしたが、仕様書はリファレンスデコーダと
   食い違う・足りない箇所がある（整数属性の `compressed` フラグと予測データの順序、PREDICTION_NONE でも値を読むこと、逆量子化は
   `val * (range / max)`、八面体法線は `s * (2 / max) - 1` からの float32 計算、エッジブレイカーのコーナーテーブルと S シンボルの頂点統合、
   属性の継ぎ目と走査、テクスチャ座標・法線予測の int64 演算）。そこはリファレンスデコーダ（C++、Apache 2.0）を翻訳して合わせた
   （`THIRD_PARTY_NOTICES.md`、ファイル先頭に著作権表示）。float は `Math.fround` で 1 演算ずつ丸め、int64 は BigInt
   （法線予測は 2^52 未満なら double の高速経路）。結果は draco3d 1.5.9（Google の WASM デコーダ、three.js の DRACOLoader と同じもの）と
   バイト単位で一致: ランダムなメッシュ（穴・裏返り・溶接・UV の継ぎ目・閉じた球、全属性型、速度 0〜10、シーケンシャル / エッジブレイカー）
   約 2,200 ケースと、Khronos glTF-Sample-Assets の glTF-Draco 版 16 モデルの全 253 プリミティブ（valence 36 本を含む）。
   draco3d の JS エンコーダは valence と圧縮シーケンシャルインデックスを出せないので、valence は結合テスト（BrainStem-draco など）で、
   圧縮インデックスはテスト専用の rANS エンコーダで書き直したストリーム（draco3d も同じメッシュに復元する）でベクトルにしている。
   壊れた入力（全切り詰め・ビット反転 2.5 万通り）は必ず `DracoError` で止まり、ハングしない。`maxValues`（= `limits.maxAccessorValues`）で
   インデックス数・属性値の数を確保前に制限する。速度は WASM の約 1/4（Khronos の Draco 16 モデル全体で 0.5 秒）。
   glTF 側（`glb.js`）: 仕様どおり、拡張があれば accessor の bufferView（非圧縮の fallback）は無視して Draco のデータで埋める。Draco が
   デコードできないときだけ fallback を使い、警告する（fallback もなければメッシュを警告付きでスキップ）。値は accessor の componentType へ
   Draco の `ConvertComponentValue`（draco3d の GetAttributeDataArrayForAllPoints、three.js の DRACOLoader と同じ）で変換し、
   そのあと accessor の normalized で正規化する。点数・成分数・インデックス数が accessor と合わない、ID が Draco のデータにない、
   インデックスが componentType に収まらない場合は `GltfValidationError`（仕様の「accessor は復元データと一致しなければならない」）。
   indices のない Draco プリミティブは Draco のインデックスを使う（Draco は点を並べ替えるので連番では描けない。three.js も同じ）。
   validate.js では拡張のオブジェクト・bufferView・attributes（プリミティブの属性の部分集合、ID は非負整数）・mode（TRIANGLES /
   TRIANGLE_STRIP）を検査し、indices のない Draco プリミティブには頂点数のモード規則を当てない。
   非圧縮版と比べると、三角形数とプリムは一致し、バウンディングボックスの差は量子化の範囲（相対 3.4e-4 以下）。VirtualCity の
   細長い橋（約 1,150 単位）だけ面積が数 % 違うが、draco3d の復元結果も同じで、元データの量子化が粗いため。
24. **公開関数名は形式に依存しない `toUsda` / `toUsdz` / `toUsdaAsync` / `toUsdzAsync`（issue #3 の案 2）。** `.gltf` も受け付けるようになり
   `glbTo*` が実態に合わなくなったため。旧名 `glbToUsda` / `glbToUsdz` / `glbToUsdaAsync` / `glbToUsdzAsync` は同じ関数オブジェクトの別名として
   残す（`export { toUsda as glbToUsda, ... }`。破壊的変更なし、非推奨にもしない）。`gltfToUsdz` にしなかったのは、既存の `gltfToUsda` が
   `GltfAsset` を受け取る下位 API で、入力の型が違う関数が同じ接頭辞で並ぶと紛らわしいから。README・CLI・デモは新しい名前を使う。
   別名であることは `test/run.js` で確認している。

## OpenUSD バリデータに指摘されて直した点（再発注意）

- `UsdPrimvarReader_float2` の `inputs:varname` は **`string`**（`token` だと MismatchedPropertyType）
- `material:binding` を持つ prim には **`prepend apiSchemas = ["MaterialBindingAPI"]`** が必須
- `extent` がないと USDZ 系チェックで警告

## 検証手順（変更のたびに必ず実行）

```bash
npm test                                   # GLB 生成 + JS テスト
npm run test:types                         # 型定義の検査（src/index.js の export を変えたとき）
node cli.js test/cube.glb /tmp/cube.usdz
pip install usd-core --break-system-packages   # 初回のみ
python3 test/validate.py /tmp/cube.usdz    # "0 validation error(s)" を確認
node cli.js test/animated.glb /tmp/animated.usdz && python3 test/validate.py /tmp/animated.usdz
node cli.js test/skinned.glb /tmp/skinned.usdz && python3 test/validate.py /tmp/skinned.usdz
node cli.js test/features.glb /tmp/features.usdz && python3 test/validate.py /tmp/features.usdz
node cli.js test/gltf/cube.gltf /tmp/cube-gltf.usdz && python3 test/validate.py /tmp/cube-gltf.usdz
npm run test:integration                   # Khronos サンプル 22 モデル（初回はネットワーク）。OpenUSD 検証込み
npm run demo                               # 見た目の確認: サンプルと fixtures の GLB を左右で比較
```

実物の GLB で確認したい場合は Khronos の glTF-Sample-Assets（Apache 2.0 / CC 系）から
`Box.glb`, `BoxTextured.glb`, `DamagedHelmet.glb`, `CesiumMilkTruck.glb`（複数ノード・共有メッシュ）,
`RiggedSimple.glb`（スキン）, `AnimatedCube.glb` あたりを `test/fixtures/` に置いて試す（リポジトリにはコミットしない）。

## 要相談（ユーザー判断待ち）

- **KHR_materials_transmission**: UsdPreviewSurface に対応入力がない。現状は警告のみ。`opacity = 1 - transmission` で近似するか
- **複数アニメーション**: 現状は 1 本（`options.animation`）。`variantSet` で切替にするか、別ノードを動かすクリップは統合するか
  （例: Khronos の InterpolationTest は 9 クリップがそれぞれ別のキューブを動かすので、統合すれば全部入る。Fox は Survey / Walk / Run）
- **CUBICSPLINE のベイク間隔**: 24fps で最大 3e-3 の誤差。もっと細かくするか


- **KHR_lights_punctual の強さ**: UsdLux は単位を規定していないので glTF の lux / candela をそのまま書いている。
  特定のレンダラ（Hydra Storm / RealityKit など）に合わせた換算が要るか
- **EXT_mesh_gpu_instancing の表現**: 今はインスタンスごとの instanceable reference に展開。数万個になる場合は
  UsdGeomPointInstancer の方がずっと小さいが、ビューア側の対応を確認してから切り替えたい

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

## npm 公開・README

- パッケージ名 `gltf2usd-js`、MIT（著作権者 activeguild、`LICENSE`）。`src/draco.js` の一部は Draco（Apache 2.0、Copyright 2016-2017
  The Draco Authors）の翻訳なので、package.json の license は `MIT AND Apache-2.0`、本文と帰属は `THIRD_PARTY_NOTICES.md`。`package.json` の `files` で公開するのは `src/`・`cli.js`・
  `README.md`・`README.ja.md`・`LICENSE`・`THIRD_PARTY_NOTICES.md` だけ（test / demo / CLAUDE.md は含めない）。`exports` は `.` と `./package.json` のみ。
  bin は `glb2usd`（1 つだけなので `npx gltf2usd-js in.glb out.usdz` でも動く）。`prepublishOnly` で `npm test`。Node は 18 以上。
- 公開前の確認: `npm pack --dry-run` で中身を見て、tarball を空のプロジェクトに入れて `import "gltf2usd-js"` と `npx glb2usd` を試す。
- **公開は GitHub Actions（`.github/workflows/publish.yml`）。** `v<semver>` のタグを push すると、タグのバージョンを
  `npm version --no-git-tag-version` で package.json に入れ、`npm test`・`npm run test:types`・`usd-core==26.11` で結合テスト（OpenUSD 検証込み）・
  `npm pack --dry-run` のあと `npm publish --provenance --access public` する。プレリリース（`-` を含む）は dist-tag `next`、それ以外は `latest`。
  同じバージョンが npm にあれば止める。シークレット `NPM_TOKEN`（npm の automation トークン）が必要。リポジトリの package.json の
  version はタグに合わせて手で上げてもよいが、公開されるのはタグのバージョン。
- **TypeScript の型定義は手書きの `src/index.d.ts`**（issue #9）。ビルド工程と devDependency を増やさないため JSDoc からの生成はしない。
  `package.json` の `types` と `exports["."].types` から参照。`test/types.ts` をパッケージ名で import して `tsc --noEmit`（`npm run test:types`、
  TypeScript は `npx` でバージョン固定）で検査し、`@ts-expect-error` で誤用が弾かれることも確かめる。公開ワークフローでも実行する。
  `src/index.js` の export と `.d.ts` の `export function / class / const` の名前の一致は `npm test`（`test/run.js`）で確認。
- **README は英語（`README.md`）が既定、日本語は `README.ja.md`。** 先頭の言語リンクで切り替える。内容を変えたら両方を同じように直す。
  README は外部の利用者向け（インストール・使い方・API・対応機能・制限・ビューア・検証・デモ・開発）。設計の経緯はこの CLAUDE.md に書く。

## コーディング規約

- ESM、セミコロンあり、ダブルクォート、2 スペースインデント
- `src/` に外部依存を追加しない。どうしても必要なら理由を README に書く
- 新機能は `test/cube-glb.js` にケースを足すか `test/fixtures/` のサンプルで検証し、`validate.py` で error 0 を保つ
- 変換で捨てた情報（未対応拡張など）は `console.warn` ではなく `ctx.warn(msg)`（= `options.onWarning`）で通知する
- OpenUSD のコードを移植・翻訳した場合は、そのファイルに Pixar の著作権表示を残し、リポジトリに `THIRD_PARTY_NOTICES.md` を追加する
- 「OpenUSD」「Pixar」を名乗らない・公式と誤認させない
