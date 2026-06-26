// message.js — メッセージ本文・ヘッダの取得と、自分のアドレス一覧の取得。

// 簡易 HTML→テキスト変換（完全な整形は目的外。LLM に渡せれば十分）。
function stripHtml(html) {
  let t = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'");
  return t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// getFull の MessagePart ツリーを再帰し、text/plain と text/html を収集する。
function collectParts(part, plains, htmls) {
  if (!part) return;
  const ct = (part.contentType || "").toLowerCase();
  if (ct.startsWith("text/plain") && part.body) {
    plains.push(part.body);
  } else if (ct.startsWith("text/html") && part.body) {
    htmls.push(part.body);
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) collectParts(p, plains, htmls);
  }
}

// text/plain を優先、無ければ text/html をテキスト化して本文文字列を返す。
async function extractBody(messageId, maxChars) {
  let bodyText = "";
  try {
    const full = await messenger.messages.getFull(messageId);
    const plains = [];
    const htmls = [];
    collectParts(full, plains, htmls);
    if (plains.length) {
      bodyText = plains.join("\n").trim();
    } else if (htmls.length) {
      bodyText = stripHtml(htmls.join("\n"));
    }
  } catch (e) {
    console.error("[LLM-Checker] extractBody failed", e);
  }
  if (maxChars && bodyText.length > maxChars) {
    bodyText = bodyText.slice(0, maxChars) + "\n…(以下省略)";
  }
  return bodyText;
}

function formatAddrList(list) {
  if (!list) return "";
  if (Array.isArray(list)) return list.join(", ");
  return String(list);
}

// MessageHeader + 本文をまとめた、LLM に渡しやすいコンテキストを作る。
async function getMessageContext(header, maxChars) {
  const body = await extractBody(header.id, maxChars);
  return {
    id: header.id,
    author: header.author || "",
    subject: header.subject || "(件名なし)",
    to: formatAddrList(header.recipients),
    cc: formatAddrList(header.ccList),
    body,
  };
}

// 自分の全アカウントの identity からメールアドレス一覧を取得（「私」の定義に使う）。
async function getMyAddresses() {
  const addrs = new Set();
  try {
    const accounts = await messenger.accounts.list();
    for (const acct of accounts) {
      for (const id of acct.identities || []) {
        if (id.email) addrs.add(id.email.toLowerCase());
      }
    }
  } catch (e) {
    console.error("[LLM-Checker] getMyAddresses failed", e);
  }
  return [...addrs];
}
