// settings.js — デフォルト設定と storage.local の読み書きヘルパ。
// background / options の両方から <script> で読み込まれ、グローバル関数を共有する。

const OLLAMA_DEFAULT_ENDPOINT = "http://localhost:11434";
const OPENAI_DEFAULT_ENDPOINT = "http://localhost:1234/v1";

const SETTINGS_DEFAULTS = {
  enabled: true,
  backend: "ollama", // "ollama" | "openai"
  endpoint: OLLAMA_DEFAULT_ENDPOINT,
  model: "gpt-oss:120b",
  apiKey: "",
  criteria: {
    addressedToMe: true, // 自分(To/Cc)宛で個人的な内容か
    needsReply: true, // 返信・対応が必要か
    important: false, // 重要・緊急・見逃せない内容か
    excludeBulk: true, // メルマガ/広告/自動送信は通知しない
  },
  customInstruction: "",
  maxBodyChars: 6000,
  failOpen: true, // LLM 失敗時はフェイルセーフで通知する
  requestTimeoutMs: 60000,
  persistentNotify: true, // クリック/クローズまで約1分間隔で通知を再表示する
  notifyShowSender: false, // 通知に差出人を表示（既定オフ: プライバシー保護）
  notifyShowSubject: false, // 通知に件名を表示（既定オフ: プライバシー保護）
};

// storage.local からマージ済みの設定を返す（ネストした criteria も既定値で補完）。
async function loadSettings() {
  const stored = await messenger.storage.local.get(SETTINGS_DEFAULTS);
  return {
    ...SETTINGS_DEFAULTS,
    ...stored,
    criteria: { ...SETTINGS_DEFAULTS.criteria, ...(stored.criteria || {}) },
  };
}

async function saveSettings(settings) {
  await messenger.storage.local.set(settings);
}
