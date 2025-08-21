// manejoRecordatorios.js
const TZ_OFFSET = process.env.TIMEZONE_OFFSET || "-03:00"; // AR por defecto

function parseRecordatorio(texto) {
  // "Recordar 2025-08-30 10:00 pagar alquiler"
  const re = /^recordar\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\s+(.+)/i;
  const m = (texto || "").trim().match(re);
  if (!m) return null;
  const [, fecha, hora, cuerpo] = m;
  return { fecha, hora: hora || "", texto: cuerpo.trim() };
}

function buildDate(fecha, hora) {
  const hhmm = /^\d{2}:\d{2}$/.test(hora || "") ? hora : "09:00";
  // construye ISO con offset fijo (evita UTC por defecto del server)
  return new Date(`${fecha}T${hhmm}:00${TZ_OFFSET}`);
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

  // Validación básica de fecha/hora
  const when = buildDate(fecha, hora);
  if (isNaN(when.getTime())) {
    await bot.sendMessage(chatId, "❌ Fecha u hora inválida.");
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Recordatorios!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[fecha, hora, userId, userName, cuerpo, "PEND", "", chatId]],
    },
  });

  await bot.sendMessage(
    chatId,
    `⏰ Recordatorio guardado para *${fecha}${
      hora ? " " + hora : ""
    }*: ${cuerpo}`,
    { parse_mode: "Markdown" }
  );
}

async function listarRecordatorios(msg, sheets, SPREADSHEET_ID, bot) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Recordatorios!A:H",
  });
  const rows = resp.data.values || [];
  const futuros = rows
    .slice(1)
    .filter((r) => r[2] == userId && (r[5] || "PEND") !== "ENVIADO")
    .map((r) => ({ fecha: r[0], hora: r[1] || "", texto: r[4] }))
    .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora))
    .slice(0, 15);

  if (!futuros.length) {
    await bot.sendMessage(chatId, "No tenés recordatorios pendientes 👍");
    return;
  }

  const texto = futuros
    .map((r) => `• ${r.fecha}${r.hora ? " " + r.hora : ""} — ${r.texto}`)
    .join("\n");
  await bot.sendMessage(chatId, `🗒️ *Tus próximos recordatorios:*\n${texto}`, {
    parse_mode: "Markdown",
  });
}

// --- Scheduler: loop o endpoint de cron ---

async function runRemindersOnce(bot, sheets, SPREADSHEET_ID) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Recordatorios!A:H",
  });
  const rows = resp.data.values || [];
  if (rows.length <= 1) return 0;

  const now = new Date();
  let enviados = 0;

  // procesar cada fila con índice (para poder actualizar el estado)
  await Promise.all(
    rows.slice(1).map(async (r, i) => {
      const rowNum = i + 2;
      const [fecha, hora, uid, usuario, texto, estado, notifiedAt, chatId] = r;

      if ((estado || "PEND") === "ENVIADO") return;

      const when = buildDate(fecha, hora);
      if (isNaN(when.getTime())) return;
      if (when > now) return;

      const target = chatId || uid;
      try {
        await bot.sendMessage(
          target,
          `⏰ Recordatorio: ${texto}\n(${fecha}${hora ? " " + hora : ""})`
        );

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Recordatorios!F${rowNum}:G${rowNum}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [["ENVIADO", new Date().toISOString()]] },
        });
        enviados++;
      } catch (e) {
        // si falla, lo dejamos en PEND para intentar nuevamente
        console.error("Reminder send error row", rowNum, e?.message || e);
      }
    })
  );

  return enviados;
}

function startReminderLoop(bot, sheets, SPREADSHEET_ID) {
  const everyMs = Number(process.env.REMINDERS_EVERY_MS || 60_000); // 1 min
  console.log(`⏲️  Reminder loop ON (cada ${everyMs} ms)`);
  setInterval(() => {
    runRemindersOnce(bot, sheets, SPREADSHEET_ID)
      .then((n) => n && console.log(`🔔 Enviados ${n} recordatorios`))
      .catch((e) => console.error("runRemindersOnce error:", e?.message || e));
  }, everyMs);
}

module.exports = {
  parseRecordatorio,
  manejarRecordatorio,
  listarRecordatorios,
  runRemindersOnce,
  startReminderLoop,
};
