// manejoRecordatorios.js
const TZ_OFFSET = process.env.TIMEZONE_OFFSET || "-03:00"; // AR por defecto

// ======== UTILIDADES FECHA/HORA ========
function two(n) {
  return String(n).padStart(2, "0");
}
function buildDate(fecha, hora) {
  const hhmm = /^\d{2}:\d{2}$/.test(hora || "") ? hora : "09:00";
  return new Date(`${fecha}T${hhmm}:00${TZ_OFFSET}`);
}

// ======== PARSEO RÁPIDO (texto "Recordar ...") ========
function parseRecordatorio(texto) {
  const re = /^recordar\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\s+(.+)/i;
  const m = (texto || "").trim().match(re);
  if (!m) return null;
  const [, fecha, hora, cuerpo] = m;
  return { fecha, hora: hora || "", texto: cuerpo.trim() };
}

// ======== CRUD HOJA ========
async function guardarRecordatorioRow({
  sheets,
  SPREADSHEET_ID,
  fecha,
  hora,
  userId,
  userName,
  texto,
  chatId,
}) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Recordatorios!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [fecha, hora || "", userId, userName, texto, "PEND", "", chatId],
      ],
    },
  });
}

// ======== LISTAR ========
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

// ======== SCHEDULER (endpoint/cron) ========
async function runRemindersOnce(bot, sheets, SPREADSHEET_ID) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Recordatorios!A:H",
  });
  const rows = resp.data.values || [];
  if (rows.length <= 1) return 0;

  const now = new Date();
  let enviados = 0;

  await Promise.all(
    rows.slice(1).map(async (r, i) => {
      const rowNum = i + 2;
      const [fecha, hora, uid, usuario, texto, estado, notifiedAt, chatId] = r;
      if ((estado || "PEND") === "ENVIADO") return;

      const when = buildDate(fecha, hora);
      if (isNaN(when.getTime()) || when > now) return;

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
        console.error("Reminder send error row", rowNum, e?.message || e);
      }
    })
  );

  return enviados;
}

function startReminderLoop(bot, sheets, SPREADSHEET_ID) {
  const everyMs = Number(process.env.REMINDERS_EVERY_MS || 60_000);
  console.log(`⏲️  Reminder loop ON (cada ${everyMs} ms)`);
  setInterval(() => {
    runRemindersOnce(bot, sheets, SPREADSHEET_ID)
      .then((n) => n && console.log(`🔔 Enviados ${n} recordatorios`))
      .catch((e) => console.error("runRemindersOnce error:", e?.message || e));
  }, everyMs);
}

// ======== FLUJO GUIADO CON MINICALENDARIO ========
const estadosRecordatorio = {}; // por chatId: { paso, fecha, hora }

function monthLabel(d) {
  const m = d.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  return m[0].toUpperCase() + m.slice(1);
}

function renderCalendar(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth(); // 0-11
  const first = new Date(y, m, 1);
  const lastDay = new Date(y, m + 1, 0).getDate();

  // Arranca lunes: 0..6 (lun..dom)
  let lead = (first.getDay() + 6) % 7;
  const rows = [];
  const header = [
    { text: "◀︎", callback_data: `rmd|nav|${y}|${two(m === 0 ? 12 : m)}` }, // prev month
    { text: monthLabel(dateObj), callback_data: "rmd|noop" },
    { text: "▶︎", callback_data: `rmd|nav|${y}|${two(m === 11 ? 13 : m + 2)}` }, // next month
  ];
  rows.push(header);
  rows.push([
    { text: "Lu", callback_data: "rmd|noop" },
    { text: "Ma", callback_data: "rmd|noop" },
    { text: "Mi", callback_data: "rmd|noop" },
    { text: "Ju", callback_data: "rmd|noop" },
    { text: "Vi", callback_data: "rmd|noop" },
    { text: "Sa", callback_data: "rmd|noop" },
    { text: "Do", callback_data: "rmd|noop" },
  ]);

  let day = 1;
  for (let r = 0; r < 6; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) {
      if (lead > 0) {
        row.push({ text: " ", callback_data: "rmd|noop" });
        lead--;
      } else if (day <= lastDay) {
        const d = two(day);
        row.push({
          text: String(day),
          callback_data: `rmd|pick|${y}|${two(m + 1)}|${d}`,
        });
        day++;
      } else {
        row.push({ text: " ", callback_data: "rmd|noop" });
      }
    }
    rows.push(row);
  }

  return {
    text: "📅 Elegí un día",
    reply_markup: { inline_keyboard: rows },
  };
}

function timeKeyboard(fecha) {
  const quick = ["08:00", "09:00", "12:00", "18:00", "20:00"];
  const rows = [
    quick.map((t) => ({ text: t, callback_data: `rmd|time|${t}` })),
    [{ text: "⏱ Sin hora (09:00)", callback_data: "rmd|time|" }],
    [{ text: "↩︎ Cambiar fecha", callback_data: "rmd|changeDate" }],
  ];
  return {
    text: `🕒 Fecha: *${fecha}*\nElegí una hora:`,
    options: {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    },
  };
}

async function iniciarRecordatorioGuiado(bot, msg, sheets, SPREADSHEET_ID) {
  const chatId = msg.chat.id;
  const now = new Date();
  estadosRecordatorio[chatId] = { paso: "cal" };
  const cal = renderCalendar(new Date(now.getFullYear(), now.getMonth(), 1));
  await bot.sendMessage(chatId, cal.text, cal.reply_markup);
}

async function manejarCallbacksRecordatorios(
  bot,
  query,
  sheets,
  SPREADSHEET_ID
) {
  const chatId = query.message.chat.id;
  const data = query.data || "";
  if (!/^rmd\|/.test(data)) return false; // no es nuestro callback

  const st = (estadosRecordatorio[chatId] ||= { paso: "cal" });
  const parts = data.split("|");

  // NAV
  if (parts[1] === "nav") {
    let y = Number(parts[2]);
    let mm = Number(parts[3]); // puede venir 0 o 13 para wrap
    if (mm <= 0) {
      y -= 1;
      mm = 12;
    }
    if (mm >= 13) {
      y += 1;
      mm = 1;
    }
    const cal = renderCalendar(new Date(y, mm - 1, 1));
    await bot.editMessageText(cal.text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: cal.reply_markup.reply_markup,
    });
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  if (parts[1] === "changeDate") {
    st.paso = "cal";
    const now = new Date();
    const cal = renderCalendar(new Date(now.getFullYear(), now.getMonth(), 1));
    await bot.editMessageText(cal.text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: cal.reply_markup.reply_markup,
    });
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // PICK DATE
  if (parts[1] === "pick") {
    const y = parts[2],
      m = parts[3],
      d = parts[4];
    st.fecha = `${y}-${m}-${d}`;
    st.paso = "time";
    const tk = timeKeyboard(st.fecha);
    await bot.editMessageText(tk.text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: tk.options.parse_mode,
      reply_markup: tk.options.reply_markup,
    });
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  // PICK TIME
  if (parts[1] === "time") {
    st.hora = parts[2] || ""; // "" => 09:00 por defecto
    st.paso = "text";
    await bot.sendMessage(chatId, "📝 ¿Qué te tengo que recordar?", {
      reply_markup: { force_reply: true, selective: true },
    });
    await bot.answerCallbackQuery(query.id, {
      text: st.hora ? `Hora ${st.hora}` : "Sin hora (09:00)",
    });
    return true;
  }

  if (parts[1] === "noop") {
    await bot.answerCallbackQuery(query.id);
    return true;
  }

  return false;
}

async function manejarPasosRecordatorio(bot, msg, sheets, SPREADSHEET_ID) {
  const chatId = msg.chat.id;
  const st = estadosRecordatorio[chatId];
  if (!st || st.paso !== "text") return false;

  const userId = msg.from.id;
  const userName =
    [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
    msg.from.username ||
    `${userId}`;

  const texto = (msg.text || "").trim();
  if (!texto) {
    await bot.sendMessage(chatId, "❌ Texto vacío. Decime qué recordarte.");
    return true;
  }

  // Validar fecha/hora y guardar
  const when = buildDate(st.fecha, st.hora);
  if (isNaN(when.getTime())) {
    await bot.sendMessage(
      chatId,
      "❌ Fecha u hora inválida. Probá de nuevo con /recordar."
    );
    delete estadosRecordatorio[chatId];
    return true;
  }

  await guardarRecordatorioRow({
    sheets,
    SPREADSHEET_ID,
    fecha: st.fecha,
    hora: st.hora,
    userId,
    userName,
    texto,
    chatId,
  });

  await bot.sendMessage(
    chatId,
    `⏰ Recordatorio guardado para *${st.fecha}${
      st.hora ? " " + st.hora : ""
    }*: ${texto}`,
    { parse_mode: "Markdown" }
  );

  delete estadosRecordatorio[chatId];
  return true;
}

// ======== ALTA RÁPIDA (texto plano) ========
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
      '❌ Formato: "Recordar 2025-08-30 10:00 pagar alquiler" (hora opcional)\nO probá /recordar para usar el calendario.'
    );
    return;
  }

  const { fecha, hora, texto: cuerpo } = parsed;
  const when = buildDate(fecha, hora);
  if (isNaN(when.getTime())) {
    await bot.sendMessage(chatId, "❌ Fecha u hora inválida.");
    return;
  }

  await guardarRecordatorioRow({
    sheets,
    SPREADSHEET_ID,
    fecha,
    hora,
    userId,
    userName,
    texto: cuerpo,
    chatId,
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

module.exports = {
  parseRecordatorio,
  manejarRecordatorio,
  listarRecordatorios,
  runRemindersOnce,
  startReminderLoop,
  buildDate,
  guardarRecordatorioRow,
};
