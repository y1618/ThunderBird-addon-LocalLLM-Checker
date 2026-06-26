// background.js — 新着メール監視・直列処理キュー・通知発火。
// 依存（lib/settings.js, lib/message.js, lib/llm.js）は manifest の scripts 配列で先に読み込まれる。

const LOG = "[LLM-Checker]";

// 処理キュー（直列実行：LLM を同時多発で叩かない）。
const queue = [];
let processing = false;

// notificationId -> messageId （クリックで該当メールを開くため）。
const notifToMessage = new Map();

// イベントはトップレベルで登録（MV3 非永続バックグラウンドでも起床できるように）。
messenger.messages.onNewMailReceived.addListener(onNewMail);
messenger.notifications.onClicked.addListener(onNotificationClicked);

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
      await showNotification(ctx, verdict.reason);
    }
  } catch (e) {
    console.error(LOG, "handleMessage error", e);
    // 本文取得などで失敗してもフェイルセーフで通知を試みる。
    if (settings && settings.failOpen) {
      try {
        await showNotification(
          { id: header.id, author: header.author, subject: header.subject },
          "処理エラー（フェイルセーフ通知）"
        );
      } catch (_) {
        /* noop */
      }
    }
  }
}

async function showNotification(ctx, reason) {
  const title = ctx.author ? String(ctx.author) : "新着メール";
  const message = `${ctx.subject || "(件名なし)"}\n${reason || ""}`.trim();
  const notificationId = await messenger.notifications.create({
    type: "basic",
    title,
    message,
    iconUrl: messenger.runtime.getURL("icons/icon-96.png"),
  });
  if (ctx.id != null) notifToMessage.set(notificationId, ctx.id);
}

async function onNotificationClicked(notificationId) {
  const messageId = notifToMessage.get(notificationId);
  if (messageId == null) return;
  try {
    await messenger.messageDisplay.open({ messageId });
  } catch (e) {
    console.error(LOG, "open message failed", e);
  } finally {
    notifToMessage.delete(notificationId);
  }
}
