# WindowFusion

複数のブラウザウィンドウをまたいで干渉し合う3Dパーティクルのデモ。

inspired by [entangled](https://github.com/ore-codes/entangled)

## デモ

`http://localhost:3000` を複数ウィンドウで開き、ウィンドウを動かすと以下が起きる。

- ウィンドウを**近づける** → オーブ間にパーティクルストリームが流れ、色が混ざる
- ウィンドウを**重ねる** → 下のウィンドウのオーブが上のウィンドウに透けて見える
- ウィンドウを**動かす** → 中身が慣性で揺れてからもとの位置に戻る

## 起動

```bash
nr dev        # /Project/me から
npm run dev   # windowfusion/ から
```

## 仕組み

### ウィンドウ位置の共有

`BroadcastChannel` API を使って、同じオリジンの全タブ/ウィンドウ間でメッセージを送受信する。各ウィンドウは 150ms ごとに自分のスクリーン座標をブロードキャストする。

```
window.screenX / window.screenY  → 物理画面上のウィンドウ位置
window.innerWidth / innerHeight  → ビューポートサイズ
window.outerHeight - innerHeight → ブラウザクロム（タブバー等）の高さ補正
```

### 3Dレンダリング（Three.js）

各ウィンドウは独立した Three.js シーンを持つ。カメラは Perspective Camera（FOV 75°, z=5）。

**オーブ**：10,000 粒子を球面座標でランダム配置。内核（50%）と外殻（50%）の密度差で立体感を出す。`PointsMaterial` + `AdditiveBlending` で発光表現。

**ストリーム**：近接ウィンドウ（エッジ間 500px 以内）に向けて、テーパード形状の粒子列を毎フレーム生成。直交ベクトルと sin/cos でうねりアニメーション。色はオーブ色から相手色へ線形補間。

**ゴーストオーブ**：ウィンドウが重なったとき、上のウィンドウが下のウィンドウのオーブをスクリーン座標差分をワールド座標に変換して自分のシーンに描画する。

### スクリーン座標 → ワールド座標の変換

```
scale = tan(FOV/2) × cameraZ / (innerHeight / 2)

worldX =  screenOffsetX × scale
worldY = -screenOffsetY × scale  // Y軸反転
```

### 慣性

ウィンドウの移動量をスプリング-マス系に入力し、オーブグループの位置を物理的に揺らす。

```
orbX -= windowMovedX × scale × INERTIA   // 移動と逆方向にずれる
orbVX += -SPRING_K × orbX × dt           // 中心へ引き戻す力
orbVX *= exp(-DAMPING × dt)              // 減衰
orbX  += orbVX × dt
```

### Z オーダー管理

各ウィンドウはフォーカス時に `focusedAt` タイムスタンプを更新してブロードキャストする。重なり判定（AABB）で `focusedAt` が新しい方を上ウィンドウと判断し、下ウィンドウのオーブをゴースト描画する。
