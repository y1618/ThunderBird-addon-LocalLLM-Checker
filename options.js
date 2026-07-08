// options.js — 設定画面のロード/保存と接続テスト。
// lib/settings.js, lib/message.js, lib/llm.js が先に読み込まれている前提。

function $(id) {
  return document.getElementById(id);
}

function setBackend(value) {
  const el = document.querySelector(`input[name=backend][value=${value}]`);
  if (el) el.checked = true;
}

function getBackend() {
  const el = document.querySelector("input[name=backend]:checked");
  return el ? el.value : "ollama";
}

async function restore() {
  const s = await loadSettings();
  $("enabled").checked = s.enabled;
  setBackend(s.backend);
  $("endpoint").value = s.endpoint;
  $("model").value = s.model;
  $("apiKey").value = s.apiKey || "";
  $("addressedToMe").checked = s.criteria.addressedToMe;
  $("needsReply").checked = s.criteria.needsReply;
  $("important").checked = s.criteria.important;
  $("excludeBulk").checked = s.criteria.excludeBulk;
  $("customInstruction").value = s.customInstruction || "";
  $("maxBodyChars").value = s.maxBodyChars;
  $("failOpen").checked = s.failOpen;
  $("persistentNotify").checked = s.persistentNotify;
  $("notifyShowSender").checked = s.notifyShowSender;
  $("notifyShowSubject").checked = s.notifyShowSubject;
}

function currentSettings() {
  return {
    enabled: $("enabled").checked,
    backend: getBackend(),
    endpoint: $("endpoint").value.trim(),
    model: $("model").value.trim(),
    apiKey: $("apiKey").value,
    criteria: {
      addressedToMe: $("addressedToMe").checked,
      needsReply: $("needsReply").checked,
      important: $("important").checked,
      excludeBulk: $("excludeBulk").checked,
    },
    customInstruction: $("customInstruction").value,
    maxBodyChars: parseInt($("maxBodyChars").value, 10) || 6000,
    failOpen: $("failOpen").checked,
    requestTimeoutMs: 60000,
    persistentNotify: $("persistentNotify").checked,
    notifyShowSender: $("notifyShowSender").checked,
    notifyShowSubject: $("notifyShowSubject").checked,
  };
}

function flash(el, msg, kind) {
  el.textContent = msg;
  el.className = "status " + (kind || "");
}

// エンドポイントの origin をホスト権限のマッチパターンに変換する
// （Firefox のマッチパターンはポートを含められず、ポートは常に全許可扱い）。
function originPattern(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch (_) {
    return null;
  }
}

// エンドポイントのホストへのアクセス権限を要求する。許可済みならダイアログは
// 表示されず true が返る。ユーザー操作ハンドラ内で最初に呼ぶこと。
async function ensureHostPermission(endpoint) {
  const pattern = originPattern(endpoint);
  if (!pattern) return true; // URL不正は後段の fetch のエラー表示に任せる
  try {
    return await messenger.permissions.request({ origins: [pattern] });
  } catch (e) {
    console.warn("permissions.request failed", e);
    return true;
  }
}

async function save() {
  const settings = currentSettings();
  const granted = await ensureHostPermission(settings.endpoint);
  await saveSettings(settings);
  if (granted) {
    flash($("status"), "保存しました", "ok");
  } else {
    flash(
      $("status"),
      "保存しましたが、このサーバへのアクセス権限が未許可のため接続できません",
      "error"
    );
  }
}

function onBackendChange() {
  const ep = $("endpoint");
  // 空、または他方のデフォルトのままなら、選択に合わせて URL を補完する。
  if (
    !ep.value ||
    ep.value === OLLAMA_DEFAULT_ENDPOINT ||
    ep.value === OPENAI_DEFAULT_ENDPOINT
  ) {
    ep.value =
      getBackend() === "openai"
        ? OPENAI_DEFAULT_ENDPOINT
        : OLLAMA_DEFAULT_ENDPOINT;
  }
}

// NetworkError 時の自動診断。バージョン・権限・素の GET の3点で原因を切り分ける。
async function runNetworkDiag(settings) {
  const lines = [];
  try {
    const info = await messenger.runtime.getBrowserInfo();
    const manifest = messenger.runtime.getManifest();
    lines.push(`環境: ${info.name} ${info.version} / アドオン v${manifest.version}`);
  } catch (_) {
    /* noop */
  }
  const pattern = originPattern(settings.endpoint);
  if (pattern) {
    try {
      const has = await messenger.permissions.contains({ origins: [pattern] });
      lines.push(
        `ホスト権限 ${pattern}: ` +
          (has ? "許可済み" : "未許可（接続テスト時のダイアログで許可してください）")
      );
    } catch (_) {
      /* noop */
    }
  }
  try {
    const origin = new URL(settings.endpoint).origin;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await fetch(origin + "/", {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      lines.push(
        `GET ${origin}/ → HTTP ${r.status}（サーバ到達OK。エンドポイントのパスやサーバ側 CORS 設定を確認）`
      );
    } finally {
      clearTimeout(t);
    }
  } catch (e2) {
    lines.push(
      `GET も失敗: ${e2.message}` +
        "（DNS/到達性/プロキシ/DoH の問題。URL をホスト名から IP 直指定に変えても試してください）"
    );
  }
  return lines.join("\n");
}

async function testConnection() {
  const settings = currentSettings();
  // 権限要求はユーザー操作の文脈が必要なため、他の await より先に行う。
  const granted = await ensureHostPermission(settings.endpoint);
  if (!granted) {
    flash(
      $("testResult"),
      "失敗: このサーバへのアクセス権限が許可されませんでした",
      "error"
    );
    return;
  }
  flash($("testResult"), "テスト中…", "");
  let myAddresses = [];
  try {
    myAddresses = await getMyAddresses();
  } catch (_) {
    /* noop */
  }
  const sampleCtx = {
    id: null,
    author: "山田太郎 <taro@example.com>",
    subject: "明日の打ち合わせの件、ご確認ください",
    to: myAddresses.join(", ") || "you@example.com",
    cc: "",
    body:
      "お世話になっております。明日14時からの打ち合わせについて、" +
      "事前に資料のご確認をお願いできますでしょうか。ご返信お待ちしております。",
  };
  const start = performance.now();
  try {
    const verdict = await judge(sampleCtx, settings, myAddresses);
    const ms = Math.round(performance.now() - start);
    flash(
      $("testResult"),
      `OK (${ms}ms)  notify=${verdict.notify}  理由: ${verdict.reason}`,
      "ok"
    );
  } catch (e) {
    let msg = "失敗: " + e.message;
    // Ollama は既定でブラウザ拡張の Origin (moz-extension://…) を 403 で拒否する。
    if (settings.backend === "ollama" && /HTTP 403/.test(e.message)) {
      msg +=
        "\n→ Ollama が拡張機能からのアクセスを拒否しています。" +
        'OLLAMA_ORIGINS="moz-extension://*" を設定して Ollama を再起動してください（README 参照）。';
    } else if (/not found/i.test(e.message)) {
      msg += "\n→ モデル名が正しいか確認してください（例: ollama list で一覧表示）。";
    } else if (/NetworkError|Failed to fetch|aborted/i.test(e.message)) {
      msg +=
        "\n→ サーバに到達できません。自動診断:\n" +
        (await runNetworkDiag(settings)) +
        "\n（プロキシ除外・DoH 等は README のトラブルシュート参照）";
    }
    flash($("testResult"), msg, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  restore();
  $("save").addEventListener("click", save);
  $("test").addEventListener("click", testConnection);
  for (const r of document.querySelectorAll("input[name=backend]")) {
    r.addEventListener("change", onBackendChange);
  }
});
