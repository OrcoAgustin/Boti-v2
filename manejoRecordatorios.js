function parseRecordatorio(texto) {
  // "Recordar 2025-08-30 10:00 pagar alquiler"
  const re = /^recordar\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\s+(.+)/i;
  const m = texto.trim().match(re);
  if (!m) return null;
  const [, fecha, hora, resto] = m;
  return { fecha, hora: hora || "", texto: resto.trim() };
}

async function manejarRecordatorio(msg, texto, sheets, SPREADSHEET_ID, bot) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName =
    [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
    msg.from.username ||
    `${userId}`;

  const parsed = parseRecordatorio(texto);
  if (!parsed) {
    await bot.sendMessage(
      chatId,
      '❌ Formato: "Recordar 2025-08-30 10:00 pagar alquiler" (hora opcional)'
    );
    return;
  }

  const { fecha, hora, texto: cuerpo } = parsed;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Recordatorios!A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[fecha, hora, userId, userName, cuerpo]] },
  });

  await bot.sendMessage(
    chatId,
    `⏰ Recordatorio guardado para *${fecha}${
      hora ? " " + hora : ""
    }*: ${cuerpo}`,
    {
      parse_mode: "Markdown",
    }
  );
}

async function listarRecordatorios(msg, sheets, SPREADSHEET_ID, bot) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Recordatorios!A:E",
  });
  const rows = resp.data.values || [];
  const hoy = new Date().toISOString().slice(0, 10);

  const mios = rows
    .filter((r) => r[2] == userId && (!r[0] || r[0] >= hoy))
    .sort((a, b) => (a[0] + (a[1] || "")).localeCompare(b[0] + (b[1] || "")))
    .slice(0, 10);

  if (!mios.length) {
    await bot.sendMessage(chatId, "No tenés recordatorios próximos 👍");
    return;
  }

  const texto = mios
    .map((r) => `• ${r[0]}${r[1] ? " " + r[1] : ""} — ${r[4]}`)
    .join("\n");
  await bot.sendMessage(chatId, `🗒️ *Tus próximos recordatorios:*\n${texto}`, {
    parse_mode: "Markdown",
  });
}

module.exports = { manejarRecordatorio, listarRecordatorios };
