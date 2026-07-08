// background.js — 新着メール監視・直列処理キュー・通知発火。
// 依存（lib/settings.js, lib/message.js, lib/llm.js）は manifest の scripts 配列で先に読み込まれる。

const LOG = "[LLM-Checker]";

// 処理キュー（直列実行：LLM を同時多発で叩かない）。
const queue = [];
let processing = false;

// 保留中の通知は storage.local に永続化する（クリックでメールを開く対応と、
// クリック/クローズまで再表示し続ける「持続通知」のため。非永続バックグラウンドの
// アンロードや Thunderbird 再起動をまたいでも維持される）。
const PENDING_KEY = "pendingNotificationsV1";
const RENOTIFY_ALARM = "llm-checker-renotify";
const RENOTIFY_PERIOD_MIN = 1; // 再通知間隔（分）
const RENOTIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 未確認でも24時間で打ち切り

// イベントはトップレベルで登録（MV3 非永続バックグラウンドでも起床できるように）。
messenger.messages.onNewMailReceived.addListener(onNewMail);
messenger.notifications.onClicked.addListener(onNotificationClicked);
messenger.notifications.onClosed.addListener(onNotificationClosed);
messenger.alarms.onAlarm.addListener(onAlarm);

console.log(LOG, "background loaded");

async function onNewMail(folder, messageList) {
  try {
    const settings = await loadSettings();
    if (!settings.enabled) return;

    // 迷惑メールフォルダはスキップ（type は将来 specialUse に移行するため両対応）。
    const isJunk =
      folder &&
      (folder.type === "junk" || (folder.specialUse || []).includes("junk"));
    if (isJunk) return;

    const messages = (messageList && messageList.messages) || [];
    for (const header of messages) queue.push(header);
    if (messages.length) {
      console.log(LOG, `queued ${messages.length} msg(s) from`, folder && folder.name);
      pump();
    }
  } catch (e) {
    console.error(LOG, "onNewMail error", e);
  }
}

async function pump() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const header = queue.shift();
      await handleMessage(header);
    }
  } finally {
    processing = false;
  }
}

async function handleMessage(header) {
  let settings;
  try {
    settings = await loadSettings();
  } catch (e) {
    console.error(LOG, "loadSettings failed", e);
    return;
  }
  if (!settings.enabled) return;

  try {
    const ctx = await getMessageContext(header, settings.maxBodyChars);
    const myAddresses = await getMyAddresses();

    let verdict;
    try {
      verdict = await judge(ctx, settings, myAddresses);
      console.log(LOG, "verdict", header.id, JSON.stringify(verdict), "subject:", ctx.subject);
    } catch (e) {
      console.error(LOG, "judge failed", e);
      if (settings.failOpen) {
        verdict = { notify: true, reason: "LLM判定に失敗（フェイルセーフ通知）" };
      } else {
        return;
      }
    }

    if (verdict.notify) {
      await showNotification(ctx, verdict.reason, settings);
    }
  } catch (e) {
    console.error(LOG, "handleMessage error", e);
    // 本文取得などで失敗してもフェイルセーフで通知を試みる。
    if (settings && settings.failOpen) {
      try {
        await showNotification(
          { id: header.id, author: header.author, subject: header.subject },
          "処理エラー（フェイルセーフ通知）",
          settings
        );
      } catch (_) {
        /* noop */
      }
    }
  }
}

// ---- 通知（プライバシー配慮の文面 + 持続再表示） ----

async function getPending() {
  const stored = await messenger.storage.local.get({ [PENDING_KEY]: {} });
  return stored[PENDING_KEY];
}

async function setPending(pending) {
  await messenger.storage.local.set({ [PENDING_KEY]: pending });
}

async function clearAlarmIfIdle(pending) {
  const hasRenotify = Object.values(pending).some((e) => !e.noRenotify);
  if (!hasRenotify) {
    await messenger.alarms.clear(RENOTIFY_ALARM);
  }
}

// 設定に従って通知の文面を組み立てる。既定では差出人・件名・本文を一切含めず、
// LLM の判定理由のみを表示する（他人の目に入っても内容が漏れないように）。
function buildNotificationContent(ctx, reason, settings) {
  const title =
    settings.notifyShowSender && ctx.author ? String(ctx.author) : "メール通知";
  const parts = [];
  if (settings.notifyShowSubject && ctx.subject) parts.push(ctx.subject);
  parts.push(reason || "通知が必要と判定されました");
  return { title, message: parts.join("\n") };
}

async function showNotification(ctx, reason, settings) {
  const { title, message } = buildNotificationContent(ctx, reason, settings);
  const notificationId = await messenger.notifications.create({
    type: "basic",
    title,
    message,
    iconUrl: messenger.runtime.getURL("icons/icon-96.png"),
  });
  const pending = await getPending();
  pending[notificationId] = {
    messageId: ctx.id ?? null,
    title,
    message,
    createdAt: Date.now(),
    noRenotify: !settings.persistentNotify,
  };
  await setPending(pending);
  if (settings.persistentNotify) {
    messenger.alarms.create(RENOTIFY_ALARM, {
      periodInMinutes: RENOTIFY_PERIOD_MIN,
    });
  }
}

// クリック: 該当メールを開き、再通知を停止。
async function onNotificationClicked(notificationId) {
  const pending = await getPending();
  const entry = pending[notificationId];
  if (entry) {
    delete pending[notificationId];
    await setPending(pending);
    await clearAlarmIfIdle(pending);
    if (entry.messageId != null) {
      try {
        await messenger.messageDisplay.open({ messageId: entry.messageId });
      } catch (e) {
        console.error(LOG, "open message failed", e);
      }
    }
  }
  try {
    await messenger.notifications.clear(notificationId);
  } catch (_) {
    /* noop */
  }
}

// クローズ: ユーザーが閉じた(byUser=true)なら確認済みとみなし再通知を停止。
// システムの自動クローズ(byUser=false)なら保留のまま残し、アラームで再表示する。
async function onNotificationClosed(notificationId, byUser) {
  const pending = await getPending();
  const entry = pending[notificationId];
  if (!entry) return;
  if (byUser || entry.noRenotify) {
    delete pending[notificationId];
    await setPending(pending);
    await clearAlarmIfIdle(pending);
  }
}

// 定期アラーム: 未確認の通知を再表示する。
async function onAlarm(alarm) {
  if (alarm.name !== RENOTIFY_ALARM) return;
  const pending = await getPending();
  const now = Date.now();
  let changed = false;
  let active = false;
  for (const [id, entry] of Object.entries(pending)) {
    if (entry.noRenotify) continue;
    if (now - entry.createdAt > RENOTIFY_MAX_AGE_MS) {
      delete pending[id];
      changed = true;
      continue;
    }
    active = true;
    try {
      // 同じ ID で作り直すと既存の通知は置き換えられ、バナーが再表示される。
      await messenger.notifications.create(id, {
        type: "basic",
        title: entry.title,
        message: entry.message,
        iconUrl: messenger.runtime.getURL("icons/icon-96.png"),
      });
    } catch (e) {
      console.error(LOG, "re-notify failed", e);
    }
  }
  if (changed) await setPending(pending);
  if (!active) await messenger.alarms.clear(RENOTIFY_ALARM);
}
