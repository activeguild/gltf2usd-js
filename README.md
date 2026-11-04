# gltf2usd.js

依存ゼロの GLB → USDA / USDZ 変換ライブラリ。ブラウザと Node の両方で動きます（ESM）。

## 使い方

```js
import { glbToUsdz, glbToUsda } from "./src/index.js";

// Node
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync("out.usdz", glbToUsdz(readFileSync("in.glb")));

// ブラウザ
const buf = await file.arrayBuffer();           // <input type="file"> など
const usdz = glbToUsdz(buf);                     // Uint8Array
const url = URL.createObjectURL(new Blob([usdz], { type: "model/vnd.usdz+zip" }));

// USDA テキストだけ欲しい場合
const { usda, files } = glbToUsda(buf);          // files = テクスチャ等 {name, bytes}[]
```

CLI: `node cli.js in.glb out.usdz` (`.usda` を指定すればテキスト出力)

テスト: `node test/make-glb.js && npm test`

## 構成

| ファイル | 役割 |
|---|---|
| `src/glb.js`  | GLB コンテナ解析、accessor デコード（stride / normalized / sparse 対応）、画像抽出 |
| `src/usda.js` | glTF → USDA。ノード階層 (Xform)、メッシュ (Mesh)、マテリアル (UsdPreviewSurface) |
| `src/usdz.js` | USDZ パッケージャ（stored-only zip、64 バイトアライン、CRC32 自前実装） |
| `src/index.js`| 公開 API |

## 現在対応しているもの（段階 1）

- GLB ヘッダ / JSON / BIN チャンク、data URI バッファ
- ノード階層、TRS または matrix（`xformOp:transform`）
- TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN、インデックス有無どちらも可
- POSITION / NORMAL / TEXCOORD_0（V 反転済み）/ COLOR_0（displayColor）
- `extent`、`MaterialBindingAPI`、`doubleSided`
- マテリアル: baseColor (factor/texture)、metallicRoughness、normal、occlusion、emissive、alphaMode (BLEND/MASK)
- テクスチャの USDZ 同梱（PNG / JPEG）
- OpenUSD 26.x の全バリデータで error 0 を確認済み

## 設計メモ

- glTF と USD はどちらも Y-up・右手系・メートル単位なので座標変換は不要。UV の V だけ反転。
- glTF の column-major 行列は、USD の row-vector 規約で 4 行ずつ書くとそのまま一致する（平行移動が最終行）。
- glTF の metallicRoughness テクスチャは G=roughness, B=metallic なので `outputs:g` / `outputs:b` をそれぞれ接続し、factor は `inputs:scale` で乗算。
- 法線マップは `scale=(2,2,2,1)`, `bias=(-1,-1,-1,0)` で [0,1] → [-1,1] に展開。
- USDZ は圧縮禁止・各ファイルのデータ先頭が 64 バイト境界必須。zip の extra field でパディングしている。

## ロードマップ

1. ~~GLB パーサ + USDA + USDZ~~ ✅
2. 共有メッシュの instancing（現在はノードごとに複製）、TEXCOORD_1、KHR_materials_* 拡張、KHR_texture_transform
3. アニメーション → `timeSamples`
4. スキン → UsdSkel、モーフターゲット → BlendShape
5. USDC (Crate) バイナリ書き出し（`pxr/usd/usd/crateFile.cpp` を参照）
