# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev           # 開発モード（ホットリロード付き）
npm run build         # TypeScriptコンパイル
npm start             # コンパイル済みJSを実行

# テスト
npm run test          # テスト実行（単発）
npm run test:watch    # テスト実行（ウォッチモード）
npm run test:coverage # カバレッジ付きテスト
npx vitest tests/handler.test.ts           # 特定ファイルのテスト
npx vitest -t "updateSession"              # 特定テスト名で絞り込み

# コード品質
npm run lint          # biomeでリントチェック
npm run lint:fix      # リント自動修正
npm run format        # コードフォーマット
npm run typecheck     # 型チェックのみ
```

### フックイベントのテスト

```bash
# stdinからJSONを渡してフック処理をテスト
echo '{"session_id":"test-123","cwd":"/tmp"}' | npx tsx src/bin/ccm.tsx hook PreToolUse
```

## Architecture

Claude Codeの複数セッションをリアルタイム監視するmacOS/Linux対応CLIツール。Ink（React for CLI）を使用したTUIとファイルベースの状態管理で動作する。

### 重要なファイルパス

- `~/.claude-monitor/sessions.json` - セッション状態の永続化ファイル
- `~/.claude/settings.json` - Claude Codeのフック設定（`ccm setup`で自動設定）
- `~/.claude/projects/*/TRANSCRIPT.md` - 各セッションの会話履歴

### データフロー

1. **Hook受信**: Claude Codeがフックイベント（PreToolUse, PostToolUse, Notification, Stop, UserPromptSubmit）を発火
2. **状態更新**: `ccm hook <event>` コマンドがstdinからJSONを受け取り、`~/.claude-monitor/sessions.json` を更新
3. **UI更新**: chokidarでファイル変更を検知し、Dashboardコンポーネントが再描画
4. **モバイルWeb同期**: WebSocketで接続中のクライアントにセッション更新をブロードキャスト

### ディレクトリ構成

- `src/bin/ccm.tsx` - CLIエントリーポイント（Commanderでコマンド定義）
- `src/hook/handler.ts` - フックイベント処理（stdin読み取り→状態更新）
- `src/store/file-store.ts` - セッション状態の永続化（JSON読み書き、TTY生存確認）
- `src/setup/index.ts` - `~/.claude/settings.json` へのフック自動設定
- `src/server/index.ts` - HTTP + WebSocketサーバー（モバイルWeb用）
- `src/components/` - InkベースのReactコンポーネント（Dashboard, SessionCard, Spinner）
- `src/hooks/useSessions.ts` - ファイル変更監視付きのReactフック
- `src/hooks/useServer.ts` - モバイルサーバー起動用フック
- `src/utils/focus.ts` - AppleScriptによるターミナルフォーカス機能
- `src/utils/status.ts` - ステータス表示ユーティリティ
- `src/types/index.ts` - 型定義（HookEvent, Session, SessionStatus, StoreData）
- `public/index.html` - モバイルWeb UI（静的HTML）

### 技術スタック

- **UI**: Ink v5 + React 18
- **CLI**: Commander
- **ファイル監視**: chokidar
- **WebSocket**: ws
- **QRコード生成**: qrcode-terminal
- **ターミナル制御**: AppleScript（macOS: iTerm2, Terminal.app, Ghostty対応）、xdotool（Linux）
- **テスト**: Vitest
- **リント/フォーマット**: Biome

### セッション管理

セッションは`session_id:tty`の形式でキー管理される。同一TTYに新しいセッションが開始されると、古いセッションは自動削除される。

**状態遷移**:
- `running`: ツール実行中（PreToolUse, UserPromptSubmitで遷移）
- `waiting_input`: 権限許可などの入力待ち（Notification + permission_promptで遷移）
- `stopped`: セッション終了（Stopで遷移）

セッションはTTYが存在しなくなると自動削除される。

### モバイルWebインターフェース

`ccm`または`ccm watch`実行時にWebサーバーが自動起動し、Dashboard UIにQRコードが表示される。スマートフォンからセッション監視とフォーカス操作が可能。

- HTTPサーバー: `public/index.html`を配信（デフォルトポート3456）
- WebSocket: セッション更新のリアルタイム同期、フォーカスコマンドの受信
- `ccm serve`で単独のWebサーバーモードとしても起動可能

### ライブラリとしての使用

```typescript
import { getSessions, getStatusDisplay, focusSession } from 'claude-code-monitor';
```

`src/index.ts`で公開APIをエクスポートしている。

### テストファイル構成

- `tests/handler.test.ts` - フックイベント処理のテスト
- `tests/file-store.test.ts` - セッション状態管理のテスト
- `tests/focus.test.ts` - ターミナルフォーカス機能のテスト
- `tests/send-text.test.ts` - テキスト送信機能のテスト
