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
  updateApiKeyVisibility();
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
  };
}

function flash(el, msg, kind) {
  el.textContent = msg;
  el.className = "status " + (kind || "");
}

async function save() {
  await saveSettings(currentSettings());
  flash($("status"), "保存しました", "ok");
}

function updateApiKeyVisibility() {
  $("apiKeyRow").style.display = getBackend() === "openai" ? "" : "none";
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
  updateApiKeyVisibility();
}

async function testConnection() {
  flash($("testResult"), "テスト中…", "");
  const settings = currentSettings();
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
