# LocalLLM Checker — Thunderbird アドオン

新着メールが届くと、ローカルで動く LLM（Ollama / LM Studio 等）にメール本文・差出人・
宛先を読ませ、**あなたが定義した基準**に従ってデスクトップ通知を「出す / 出さない」を
自動判定する Thunderbird 拡張機能です。

- 「自分宛で返信が必要なメールだけ通知してほしい」
- 「メルマガや自動送信は通知しないでほしい」

といった判断を、ローカル LLM の意味理解で行います。メール内容は外部に送られず、
あなたのマシン上の LLM だけで処理されます。

## 必要なもの

- Thunderbird 128 ESR 以降
- ローカル LLM サーバのいずれか
  - **Ollama** … `ollama serve`（既定 `http://localhost:11434`）。例: `ollama pull gpt-oss:120b`
  - **OpenAI 互換** … LM Studio / llama.cpp `--api` / vLLM など（例 `http://localhost:1234/v1`）

## 開発用に読み込む（一時インストール）

1. ローカル LLM を起動しておく（例: `ollama run gpt-oss:120b`）。
2. Thunderbird → メニュー → **アドオンとテーマ** → 歯車アイコン → **アドオンをデバッグ**
   （または URL バーに `about:debugging` を開く）。
3. **一時的なアドオンを読み込む** をクリックし、本フォルダの `manifest.json` を選択。
4. アドオン一覧の本拡張の **設定** からオプション画面を開き、バックエンド・エンドポイント・
   モデル名・判定基準を設定 → **接続テスト** で疎通を確認。

> 一時インストールは Thunderbird を再起動すると消えます。恒久利用は下記のパッケージ参照。

## 設定項目

| 項目 | 説明 |
| --- | --- |
| バックエンド | `Ollama` または `OpenAI 互換` |
| エンドポイント URL | Ollama は `http://localhost:11434`、OpenAI 互換は `…/v1` まで |
| モデル名 | 例: `gpt-oss:120b`, `qwen3`, `llama3.3` |
| API キー | OpenAI 互換サーバが要求する場合のみ（ローカルは通常不要） |
| 判定基準（トグル） | 自分宛/返信要否/重要度/一斉配信除外 を組み合わせ |
| 追加の指示 | 自由記述。「上司◯◯さんは必ず通知」等を自然文で |
| フェイルセーフ | LLM 接続失敗時に念のため通知するか（既定 ON） |
| 本文の最大文字数 | LLM に渡す本文を切り詰める上限（既定 6000） |

## Open WebUI 経由で使う（API キー認証）

Ollama を [Open WebUI](https://github.com/open-webui/open-webui) 経由で使うと、
API キーでアクセス制御でき、後述の `OLLAMA_ORIGINS` の設定も不要になります
（Origin チェックは Open WebUI がサーバ側で Ollama を呼ぶため発生しません）。

| 設定項目 | 値 |
| --- | --- |
| バックエンド | **OpenAI 互換** |
| エンドポイント URL | `http://localhost:3000/api`（`/chat/completions` は自動で付与） |
| モデル名 | Open WebUI のモデル一覧に表示される名前（例: `qwen3:8b`） |
| API キー | Open WebUI の **設定 → アカウント → API キー** で発行した `sk-…` |

※ 管理者設定で API キー認証が有効になっている必要があります
（管理者パネル → 設定 → 一般）。
※ Open WebUI が別マシン/別ホスト名で動いている場合は、初回の「接続テスト」時に
そのホストへのアクセス許可ダイアログが表示されるので許可してください
（`manifest.json` の編集は不要です）。

## 仕組み（概要）

`background.js` が `messenger.messages.onNewMailReceived` を購読し、新着を直列キューで
1 通ずつ処理します。各メールは本文（text/plain 優先、無ければ HTML をテキスト化）と
ヘッダを抽出し、あなたの全アカウントの自分のメールアドレスとともに LLM へ渡します。
LLM は `{"notify": <bool>, "reason": "<理由>"}` を返し、`notify=true` のときだけ通知します。

```
manifest.json     … 拡張のメタ情報・権限・background/options 宣言
background.js      … 新着監視・キュー・通知
lib/settings.js    … 既定値と storage.local の読み書き
lib/message.js     … 本文/ヘッダ抽出・自分のアドレス取得
lib/llm.js         … プロンプト生成・Ollama/OpenAI 呼び出し・JSON パース
options.html/js/css… 設定画面（接続テスト付き）
icons/             … アイコン
```

## 配布用にパッケージする（.xpi）

本フォルダ直下（`manifest.json` がルートに来るように）で zip 化します。

```bash
zip -r -FS ../localllm-checker.xpi . -x '*.git*' -x 'README.md'
# または web-ext を使う場合:
#   npm install -g web-ext && web-ext build
```

個人利用なら署名不要です。`addons.thunderbird.net` で配布する場合は署名が必要です。

## トラブルシュート

- **接続テストが `HTTP 403` で失敗する（Ollama）**: Ollama はブラウザ拡張からの
  リクエスト（`Origin: moz-extension://…`）を既定で拒否します。API キーの問題では
  ありません。環境変数 `OLLAMA_ORIGINS` に拡張機能の Origin を許可してください。

  systemd で Ollama を動かしている場合（Linux の標準インストール）:

  ```bash
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  sudo tee /etc/systemd/system/ollama.service.d/allow-thunderbird.conf >/dev/null <<'EOF'
  [Service]
  Environment="OLLAMA_ORIGINS=moz-extension://*"
  EOF
  sudo systemctl daemon-reload && sudo systemctl restart ollama
  ```

  手動起動の場合: `OLLAMA_ORIGINS="moz-extension://*" ollama serve`

  ※ `OLLAMA_ORIGINS=*`（全許可）はブラウザ上の任意のサイトからアクセス可能に
  なるため推奨しません。`moz-extension://*` に限定してください。
  なお「Open WebUI 経由で使う」構成（上記）ならこの設定自体が不要です。
- **モデルが見つからないエラー**: `ollama list` でインストール済みモデル名を確認し、
  設定画面のモデル名を一致させてください（例: `qwen3-coder-next:q4_K_M`）。
- **`NetworkError` で失敗する（社内プロキシ環境・別マシンのサーバ）**: 次を順に確認:
  1. **サーバへの到達性**: 同じマシンのターミナルから
     `curl http://<サーバ>:<ポート>/health` 等で応答するか確認。
  2. **ホスト権限**: `localhost` 以外のサーバは、初回の「接続テスト」時に
     アクセス許可ダイアログが出ます。許可してください。
  3. **プロキシ除外**: 社内プロキシ環境では、Thunderbird → 設定 → 一般 →
     最下部の「接続設定…」を開き、
     - 「手動でプロキシを設定する」の場合 → **「プロキシなしで接続」** に
       社内サーバのホスト名/ドメイン/IP 帯を追加
       （例: `openwebui.corp.example.com`, `.corp.example.com`, `192.168.0.0/16`）
     - 「システムのプロキシ設定を利用する」の場合 → OS 側の `no_proxy`
       環境変数や「無視するホスト」に追加
     - 自動設定 (PAC) の場合 → PAC が社内宛を DIRECT で返すか管理者に確認

     なお `localhost` / `127.0.0.1` は既定でプロキシを経由しません。
  4. **https の場合**: 社内 CA の証明書を Thunderbird が信頼しているか確認
     （設定 → プライバシーとセキュリティ → 証明書）。
- **通知が出ない**: オプションの「接続テスト」を実行。`background` のログは
  `about:debugging` → 本拡張の **検証 (Inspect)** で確認できます。
- **localhost に繋がらない**: LLM サーバが起動しているか、エンドポイント URL とポートを確認。
  Ollama は `127.0.0.1`/`localhost` のいずれでも可。別ホスト/別ポートを使う場合は
  `manifest.json` の `host_permissions` にそのホストを追加してください。
- **判定が不安定**: モデルを変える、または「追加の指示」で基準を具体化すると安定します。

## 注意 / 既知の制限

- MV3 の非永続バックグラウンドはアイドル時にアンロードされますが、新着イベントで起床します。
  通知クリックで該当メールを開く対応表はメモリ上に持つため、長時間後のクリックでは
  開けないことがあります（通知自体は表示されます）。
- HTML 専用メールのテキスト化は簡易実装です。
- 迷惑メールフォルダへの配信はスキップします。

## ライセンス

[MIT License](LICENSE) © 2026 y1618
