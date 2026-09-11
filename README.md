# Elapsed Notify

[Orca](https://github.com/stablyai/orca) 用プラグイン。エージェントが放置されている時間を検知し、
プロンプトキャッシュ切れの前に通知＆自動 `/compact` を行う。

## これは何をするか

Claude Code 等のプロンプトキャッシュは 1 時間 TTL。エージェントが応答を止めた（`done` /
`waiting` / `blocked`）まま放置されると、次に指示を送ったときにキャッシュが切れてコストが増える。

このプラグインは放置時間を計測し、次の 2 段階で対処する（時間・文言は既定値。[設定のカスタマイズ](#設定のカスタマイズ)参照）。

| 経過時間（既定） | 動作 |
|---|---|
| 50 分 | 🟡 通知のみ（そろそろキャッシュ切れが近い） |
| 55 分 | 🔴 通知 ＋ `orca` CLI 経由で対象ワークツリーに `/compact` を自動送信 |

放置がその前に終わる（ユーザーが指示を送って `working` に戻る）場合は、タイマーはクリアされ何も起きない。

## 前提条件

- Orca `>= 1.4.0`
- `orca` CLI が `$PATH` から解決できること
  （プラグインワーカーの環境変数 allowlist に `PATH` が含まれているため動作する）

## インストール

`~/.orca/plugins/`（または Orca が読み込むプラグインディレクトリ）に本リポジトリを配置し、
Orca 側でプラグインを有効化する。

## 設定のカスタマイズ

通知タイミングと文言は、プラグイン直下に `config.json` を置くと上書きできる。
テンプレートを `config.example.json` としてリポジトリに同梱しているので、コピーして編集する。

```bash
cp config.example.json config.json
```

```json
{
  "notifyMinutes": [50, 55],
  "compactMinute": 55,
  "messages": {
    "warning": {
      "title": "🟡 {label}: 放置{minutes}分",
      "body": "そろそろキャッシュ切れが近い、確認して"
    },
    "compact": {
      "title": "🔴 {label}: 放置{minutes}分",
      "body": "キャッシュ切れ確定ライン。これから/compactを自動実行するよ"
    }
  }
}
```

| キー | 説明 |
|---|---|
| `notifyMinutes` | 通知する経過分数の配列。何段階でも増やせる（例: `[30, 50, 55]`） |
| `compactMinute` | `/compact` を自動送信するタイミング（`notifyMinutes` に含める必要はない）。省略時は `notifyMinutes` の最大値 |
| `messages.warning` | `compactMinute` 以外のタイミングで出す通知の `title`/`body` |
| `messages.compact` | `compactMinute` のタイミングで出す通知の `title`/`body` |

`title`/`body` は `{label}`（ワークツリー名）と `{minutes}`（経過分数）をプレースホルダーとして使える。

`config.json` は個人設定なので `.gitignore` 対象にしてある。指定したキーだけ上書きすれば良く、
省略したキーは既定値がそのまま使われる。ファイルが存在しない・壊れている場合も既定値にフォールバックする。

設定はプラグインワーカーの起動時（`activate()`）に読み込まれる。ワーカーは 5 分アイドルで
再フォークされるため、変更はおおむね数分以内に反映されるが、即時反映ではない点に注意。

## 設計上の注意点

### なぜ「settled」という状態を持つのか

`/compact` の送信自体もエージェントを一時的に `working` へ遷移させる。これを素朴に
「compact 完了 = done = 新しい放置サイクルの開始」として扱うと、55 分おきに永遠に
compact が走り続けるループになってしまう。

これを防ぐため、compact 送信後はそのワークツリーを **settled（確定済み）** 状態にし、
ユーザーが本当に次の指示（`working`）を送るまで、通知も compact も一切トリガーしない。

settled 化には 2 つの経路がある。

- **システムによる自動 compact**: `/compact` の送信（`execFile`）が成功した時点で即座に
  settled 化する。実際に compact が完了したかまでは確認しない。目的がキャッシュ対策という
  軽微なものであり、万一送信が実行に至らなくても実害は小さい一方、完了確認のポーリングは
  無駄なコストになるため、送信成功をもって良しとする判断。
- **人間による手動 compact**: `agent.status.changed` の `done` 系イベント受信時、ターミナル
  の preview に Claude Code が compact 完了時に表示する `recap:` という文言があれば、
  直前の `working` は手動 compact の処理だったとみなし settled 化する。

### 既知の制約

- プラグインは Orca アプリ全体で ON/OFF される。プロジェクトやワークツリー単位で
  スコープを絞る設定項目はない。
- `/config` で recap 表示を OFF にしている場合、手動 compact の検知は機能しない
  （システム自動 compact の検知には影響しない）。
- プラグインワーカーは 5 分間アイドルだと自動破棄され、次のイベントで再フォークされる。
  50/55 分の長時間タイマーを保持するため、待機中は 4 分おきに軽い host call を打って
  keep-alive している。ワーカーが再起動されても、放置開始時刻と settled 状態は
  storage に永続化してあるため復元される。

## License

[MIT](./LICENSE)
