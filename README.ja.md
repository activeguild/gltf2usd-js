# gltf2usd-js

[English](README.md) | **日本語**

glTF 2.0（`.glb` / `.gltf`）を USDZ / USDA に変換するライブラリです。ブラウザでも Node.js でも動き、**依存パッケージはありません**。

- どこでも同じ 1 つの ES モジュールで動きます。使うのは `ArrayBuffer` / `DataView` / `TextEncoder` だけです。
- 出力は **Apple の AR Quick Look** を想定しています。iOS の AR Quick Look と macOS の Finder の Quick Look で、スケルトンアニメーション・ノードアニメーション・頂点アルファを含めて実機で確認しています。
- 出力は OpenUSD 26.11 のバリデータでエラー 0 を確認しています。入力は変換前に glTF 2.0 の仕様に沿って検査し、不正なファイルはわかりやすいエラーで止めます。

```js
import { toUsdz } from "gltf2usd-js";

const usdz = toUsdz(glbBytes); // Uint8Array。そのまま保存したり AR Quick Look で開いたりできる
```

## 目次

- [インストール](#インストール)
- [使い方](#使い方) — [Node.js](#nodejs)、[ブラウザ](#ブラウザ)、[CLI](#cli)
- [API](#api)
- [対応している glTF の機能](#対応している-gltf-の機能)
- [制限事項](#制限事項)
- [ビューアについて](#ビューアについて)
- [入力の検証](#入力の検証)
- [デモ](#デモ)
- [開発](#開発)
- [ライセンス](#ライセンス)

## インストール

```bash
npm install gltf2usd-js
```

Node.js 18 以降が必要です。ブラウザは、ES モジュールに対応した最近のものなら動きます。

TypeScript の型定義（`src/index.d.ts`）を同梱しています。`@types` のパッケージは不要です。

## 使い方

### Node.js

```js
import { readFileSync, writeFileSync } from "node:fs";
import { toUsdz } from "gltf2usd-js";

writeFileSync("model.usdz", toUsdz(readFileSync("model.glb")));
```

外部の `.bin` や画像を参照する `.gltf` の場合は、それらのファイルを `resources` で渡します。

```js
import { toUsdz } from "gltf2usd-js";

const usdz = toUsdz(readFileSync("scene.gltf", "utf8"), {
  resources: {
    "scene.bin": readFileSync("scene.bin"),
    "textures/base.png": readFileSync("textures/base.png"),
  },
});
```

`resources` には、`Map`、普通のオブジェクト、`(uri) => bytes` の関数のどれでも渡せます。uri はまず書かれたまま、次にパーセントデコードして、最後にファイル名だけで探します。

### ブラウザ

```js
import { toUsdzAsync } from "gltf2usd-js";

const file = input.files[0];                        // <input type="file">
const usdz = await toUsdzAsync(await file.arrayBuffer());
const url = URL.createObjectURL(new Blob([usdz], { type: "model/vnd.usdz+zip" }));

// iOS の AR Quick Look: <a rel="ar" href={url}><img ...></a>
```

USDZ には PNG と JPEG しか入れられないので、非同期版の関数は WebP のテクスチャ（`EXT_texture_webp`）も、ブラウザ自身の画像デコーダで PNG / JPEG に変換します。同期版（`toUsdz` / `toUsda`）はどこでも同じように動きますが、WebP のテクスチャは警告を出して捨てます。

### CLI

```bash
npx gltf2usd-js model.glb model.usdz
```

出力のファイル名を `model.usda` にすると、USDA のテキストを書き出します。`.gltf` を入力にした場合、外部ファイルは入力ファイルと同じフォルダ（とその下）からだけ読みます。警告は標準エラーに出ます。パッケージをインストールしたあとは、`glb2usd` というコマンド名で使えます。`--double-sided-faces` を付けると `doubleSided: "faces"` オプションになります。

## API

### 変換関数

| 関数 | 戻り値 | |
|---|---|---|
| `toUsdz(input, options?)` | `Uint8Array` | USDZ パッケージ |
| `toUsda(input, options?)` | `{ usda: string, files: { name, bytes }[] }` | USDA のテキストと、それが参照するテクスチャ |
| `toUsdzAsync(input, options?)` | `Promise<Uint8Array>` | `toUsdz` と同じだが、先に WebP のテクスチャを変換する |
| `toUsdaAsync(input, options?)` | `Promise<{ usda, files }>` | `toUsda` と同じだが、先に WebP のテクスチャを変換する |

元の名前 `glbToUsdz` / `glbToUsda` / `glbToUsdzAsync` / `glbToUsdaAsync` も同じ関数で、引き続き使えます（名前に glb とありますが `.gltf` も受け付けます）。

`input` には次のどれでも渡せます：GLB / `.gltf` のバイト列（`ArrayBuffer` / `Uint8Array`）、`.gltf` の JSON テキスト、パース済みの glTF オブジェクト。

### オプション

| オプション | 既定値 | |
|---|---|---|
| `resources` | — | `.gltf` の外部ファイル（[使い方](#nodejs)を参照） |
| `onWarning(message)` | — | 変換できなかった glTF のデータ（未対応の拡張・プリミティブのモード・2 本目以降のアニメーションなど）について、種類ごとに 1 回呼ばれる |
| `animation` | `0` | 変換する glTF アニメーションの番号か名前。USD のステージにはタイムラインが 1 本しかないので、書き出すアニメーションは 1 本だけ |
| `animationMode` | `"skeleton"` | `"skeleton"` はノードアニメーションを剛体の UsdSkel スケルトンとして書く（AR Quick Look で再生できる）。`"xform"` は時間サンプル付きの `xformOp` として書く（AR Quick Look では再生されない） |
| `doubleSided` | `"attribute"` | 両面表示のマテリアルの書き方。`"attribute"` は USD の `doubleSided` を書く（Quick Look と AR Quick Look は無視する）。`"faces"` は代わりに各三角形を裏返したコピーを足す（法線は面の角ごとになり、裏面では反転）ので、裏側もそこで描かれる。そのメッシュの面数は 2 倍になる |
| `instancing` | `true` | 複数のノードが使うメッシュを 1 回だけ書き、instanceable な参照にする。`false` にすると複製する |
| `texturePrefix` | `"textures/"` | 同梱するテクスチャのフォルダ |
| `layerName` | `"model.usda"` | USDZ の中のルートレイヤーのファイル名 |
| `limits` | `DEFAULT_LIMITS` | リソースの上限（[入力の検証](#入力の検証)を参照） |
| `convertImage(bytes, mimeType)` | ブラウザのデコーダ | 非同期版だけ。`{ bytes, mimeType: "image/png" \| "image/jpeg" }` か `null` を返す。Node では、画像ライブラリなどを使った自前の関数を渡す |

### エラー

| エラー | 起きるとき |
|---|---|
| `GltfValidationError` | 入力が正しい glTF 2.0 でないとき、または `limits` を超えたとき。メッセージに問題の場所が入る（例：`mesh 0 primitive 1: NORMAL (accessor 4) has 3 elements, POSITION (accessor 2) has 4`） |
| `UsdzLimitError` | 出力が普通の zip（ZIP64 でないもの）に収まらないとき。ファイルや全体が 4 GiB 以上、エントリが 65535 個より多い、エントリ名が 65535 バイトより長い、のいずれか |

```js
import { toUsdz, GltfValidationError } from "gltf2usd-js";

try {
  toUsdz(bytes, { onWarning: (m) => console.warn(m) });
} catch (e) {
  if (e instanceof GltfValidationError) console.error("glTF として不正:", e.message);
  else throw e;
}
```

### 下位レベルの関数

`parseGltf`、`parseGLB`、`GltfAsset`（パースと accessor のデコード）、`gltfToStage`（glTF → メモリ上の USD レイヤー）、`gltfToUsda`（`GltfAsset` → `{ usda, files }`。`gltfToStage` + `writeUsda` で、`toUsda` と違いパース済みの asset を受け取る）、`writeUsda`（レイヤー → テキスト）、`packUsdz`（ファイル群 → USDZ）、`browserImageConverter`、`DEFAULT_LIMITS`、`DataUnavailableError`。

型定義からは、オプションと戻り値の型（`ConvertOptions`、`AsyncConvertOptions`、`StageOptions`、`GltfInput`、`ResourceSource`、`ImageConverter`、`Limits`、`UsdaResult`、`PackagedFile` など）も import できます。

```ts
import { toUsdz, type ConvertOptions } from "gltf2usd-js";

const options: ConvertOptions = { animationMode: "skeleton", onWarning: console.warn };
const usdz: Uint8Array = toUsdz(bytes, options);
```

## 対応している glTF の機能

**形状**
- ノードの階層。変換は TRS か `matrix`
- TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN。インデックスはあってもなくてもよい
- POSITION、NORMAL（ないときは面ごとの法線）、TEXCOORD_n、COLOR_0
- sparse accessor、normalized の accessor、行列の accessor（MAT2 / MAT3 の列ごとのパディングを含む）
- 複数のノードで共有されるメッシュは、1 つのプロトタイプへの instanceable な参照になる

**マテリアル**（UsdPreviewSurface）
- ベースカラー、メタリック・ラフネス、法線、オクルージョン、エミッシブ（それぞれ係数とテクスチャ）。alphaMode の BLEND / MASK、両面表示（Quick Look での扱いは[制限事項](#制限事項)を参照）
- PNG / JPEG のテクスチャ、サンプラーのラップモード、複数の UV セット
- BLEND / MASK のマテリアルでの頂点アルファ（`COLOR_0` の VEC4）。Quick Look は頂点ごとの不透明度を直接読めないので、アルファのランプ画像と専用の UV セットで表す
- 透過するガラス（`KHR_materials_transmission`）は半透明にする: opacity = `max(1 − transmissionFactor × (1 − metallicFactor), 0.2)`（glTF と同じく金属は透過しない）

**アニメーション・スキン・モーフターゲット**（UsdSkel）
- スキンは Skeleton / SkelAnimation / ジョイントのウェイトになる（JOINTS_n / WEIGHTS_n はいくつでも）
- モーフターゲットは BlendShape になる。ウェイトは固定値でもアニメーションでもよい
- ノードアニメーションは、剛体スケルトン（既定）か xformOp の時間サンプルになる
- 補間は LINEAR と STEP が正確。CUBICSPLINE は 24fps でベイクする

**拡張**

| 拡張 | 対応 |
|---|---|
| `KHR_texture_transform` | ✅ `UsdTransform2d` |
| `KHR_materials_emissive_strength`、`KHR_materials_ior`、`KHR_materials_clearcoat` | ✅ |
| `KHR_materials_unlit` | ✅ 近似（ディフューズを黒にして発光で表す） |
| `KHR_materials_transmission` | ✅ opacity で近似: `max(1 − transmissionFactor × (1 − metallicFactor), 0.2)`（屈折なし。下限 0.2 は透明なガラスが消えないため）。`MASK` では無視、`transmissionTexture` と metallic のテクスチャは無視 |
| `KHR_materials_variants` | ✅ variantSet `materialVariant` |
| `KHR_lights_punctual` | ✅ UsdLux（強さはそのまま書く。AR Quick Look はライトを無視する） |
| `KHR_mesh_quantization` | ✅ |
| `EXT_meshopt_compression` | ✅ デコーダを内蔵 |
| `KHR_meshopt_compression` | ✅ デコーダを内蔵（頂点コーデック v0 / v1、`COLOR` を含む全フィルタ） |
| `KHR_draco_mesh_compression` | ✅ デコーダを内蔵（Draco ビットストリーム 2.2。Google のデコーダと同じ結果） |
| `EXT_mesh_gpu_instancing` | ✅ インスタンスごとに instanceable な参照（`_` で始まる独自属性は警告を出して無視） |
| `EXT_texture_webp` | ✅ 非同期 API のみ（PNG / JPEG に変換） |

## 制限事項

- **頂点カラーの RGB とマテリアル:** マテリアルのあるメッシュでは、頂点カラーの RGB を `displayColor` として書きますが、マテリアルの色には掛けません。
- **頂点アルファとベースカラーテクスチャ:** 頂点アルファとベースカラーテクスチャのアルファは掛け合わせず、テクスチャのアルファを使います。UsdPreviewSurface では 2 つの入力を掛け合わせられないためです。ただし、アルファのないベースカラーテクスチャ（JPEG、またはアルファも `tRNS` もない PNG）は glTF ではアルファ 1 なので、不透明度はテクスチャではなく `baseColorFactor` と頂点アルファから取ります。
- **両面表示のマテリアル:** `doubleSided` は USD の `doubleSided` として書きますが、Quick Look と AR Quick Look はこれを無視して表面だけを描くため、裏から見える面は消えます（警告を出します）。オプション `doubleSided: "faces"`（CLI では `--double-sided-faces`）を指定すると、代わりに裏面を書きます。その場合、モーフターゲットの法線の差分は適用されず（UsdSkel は点ごとの法線にしか適用しない）、マテリアルバリアントによって両面かどうかが違うメッシュはどのバリアントでも裏面を持ちます（どちらも警告を出します）。この裏面が Quick Look で表示されるかは、まだ実機で確認していません。
- **プリミティブのモード:** POINTS / LINES のプリミティブは、警告を出して飛ばします。
- **アニメーション:** 変換するのは 1 本だけで、`options.animation` で選びます。
- **シーン:** 変換するのは既定のシーン（`scene`、なければ最初のシーン）だけです。ほかのシーンがあれば警告を出します。
- **透過:** UsdPreviewSurface には透過・屈折がないので、透過するマテリアルは半透明で表します。完全に透過するガラスも、見えなくならないよう opacity 0.2 を残します。glTF と同じく透過するのは金属でない部分だけで、完全に金属のマテリアルは不透明のままです（`metallicRoughnessTexture` の metallic チャンネルは見ず、`metallicFactor` だけを使います）。`transmissionTexture` と、MASK・unlit のマテリアルの透過は無視します。
- **未対応:** カメラ、KHR_materials_volume / specular / sheen、clearcoat の法線テクスチャ、モーフターゲットの接線、KTX2 のテクスチャ、USDC（バイナリ）出力、ZIP64。

捨てた情報は、すべて `onWarning` で知らせます。

## ビューアについて

- **確認済みのビューア:** iOS の AR Quick Look と macOS の Finder の Quick Look で、スキン・ノードアニメーション・頂点アルファを含めて再生できます。構成は Apple の見本に合わせています（defaultPrim が `SkelRoot` で、`SkelAnimation` は `Skeleton` の子）。
- **xformOp のアニメーション:** AR Quick Look は、時間サンプル付きの xformOp を再生しません。ノードアニメーションを既定でスケルトンとして書くのはこのためです。
- **スケール 0:** Quick Look は、スケールがちょうど 0 のジョイントがあると、そのスケルトン全体のスキニングをやめます（例: 各コマを 0 から 1 に拡大して見せるパラパラ漫画）。その場合、全部のコマが同時に出るか、どれも出ません。OpenUSD とデモでは正しく再生されます。
- **Reality Converter:** ルートレイヤーが USDC のパッケージしか受け付けません。USDC の出力はまだ実装していません。

## 入力の検証

変換の前に、入力を glTF 2.0 の仕様に沿って検査します。不正なファイルは `GltfValidationError` で止め、0 で埋めたり切り詰めたりして黙って続けることはしません。検査する項目は次のとおりです。

- **GLB の構造:** ヘッダー、チャンクの並びと境界、長さが入力のサイズと合うか
- **バッファ・バッファビュー・アクセサー:** バイト範囲、ストライドと境界、要素数と型、sparse
- **メッシュ:** 属性の型と要素数、番号（`TEXCOORD_0`、`TEXCOORD_1`、…）、JOINTS / WEIGHTS の対、モードごとに必要な要素数、インデックスの予約値
- **参照:** ノード・メッシュ・スキン・アニメーションの間の参照。ノードの階層に循環がないこと
- **EXT_mesh_gpu_instancing の属性**

見た目だけのデータの問題（テクスチャ・ライト・バリアントが見つからないなど）は警告にとどめ、モデルは変換します。

`DEFAULT_LIMITS` はメモリとスタックを守るための上限で、`options.limits` で上げ下げできます（`Infinity` で無効）。

| 上限 | 既定値 |
|---|---|
| `maxInputBytes` | 2 GiB |
| `maxAccessorValues` | accessor 1 本あたり 2^26 個の値 |
| `maxNodeDepth` | 1024 |
| `maxBuffers` / `maxBufferViews` / `maxAccessors` / `maxMeshes` / `maxNodes` | それぞれの配列の数 |

## デモ

```bash
git clone https://github.com/activeguild/gltf2usd-js.git
cd gltf2usd-js
npm run demo          # http://localhost:8080/demo/
```

GLB をページにドロップすると、元の glTF（three.js）と変換した USD を並べて表示します。構造のチェック結果、USDA のテキスト、Prim ツリーも見られます。iPhone / iPad では、結果を AR Quick Look で開けます。デモは静的ファイルだけでできているので、Vercel や GitHub Pages などにそのまま置けます。three.js を使うのはデモだけで、ライブラリ本体には依存パッケージがありません。

## 開発

```bash
npm test                        # 単体テスト（ネットワーク不要）
npm run test:types              # test/types.ts を src/index.d.ts で型チェック（TypeScript は npx で取得）
npm run test:integration        # Khronos glTF-Sample-Assets の 22 モデル（初回だけダウンロード。コミットと SHA-256 で固定）
pip install usd-core            # 任意。結合テストと test/validate.py で OpenUSD のバリデータを使えるようになる
python3 test/validate.py model.usdz
```

### リリース

バージョンのタグを push すると、GitHub Actions がそのバージョンで npm に公開します（`.github/workflows/publish.yml`）。

```bash
git tag v0.2.0
git push origin v0.2.0
```

バージョンはタグから取るので、先に `package.json` を書き換える必要はありません。`v0.2.0-beta.1` のようなプレリリースのタグは、npm の dist-tag `next` で公開します。単体テスト・型チェック・結合テスト・OpenUSD のバリデータが通らないとき、そのバージョンがすでに npm にあるときは公開しません。リポジトリのシークレット `NPM_TOKEN` に npm の automation トークンが必要です。公開は provenance 付きです。

設計メモと、出力の構成をこうした理由は [CLAUDE.md](CLAUDE.md) にあります。

## ライセンス

[MIT](LICENSE) © activeguild

Draco のデコーダ（`src/draco.js`）の一部は Google のリファレンスデコーダを翻訳したもので、Apache License 2.0 に従います（そのため `package.json` の license は `MIT AND Apache-2.0`）。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

出力は普通の USD です。「OpenUSD」「Pixar」の名前は、フォーマットと参照用のバリデータを指すためだけに使っています。このプロジェクトはそれらとは関係ありません。
