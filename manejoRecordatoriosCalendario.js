const {
  buildDate,
  guardarRecordatorioRow,
} = require("./manejoRecordatorios.js");

const estadosRecordatorio = {}; // por chatId: { paso, fecha, hora }

function two(n) {
  return String(n).padStart(2, "0");
}
function monthLabel(d) {
  const m = d.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  return m[0].toUpperCase() + m.slice(1);
}

function renderCalendar(dateObj) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth(); // 0..11
  const first = new Date(y, m, 1);
  const lastDay = new Date(y, m + 1, 0).getDate();

  // Lunes=0
  let lead = (first.getDay() + 6) % 7;
  const rows = [];
  rows.push([
    { text: "◀︎", callback_data: `rmd|nav|${y}|${two(m === 0 ? 12 : m)}` },
    { text: monthLabel(dateObj), callback_data: "rmd|noop" },
    { text: "▶︎", callback_data: `rmd|nav|${y}|${two(m === 11 ? 13 : m + 2)}` },
  ]);
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
        row.push({
          text: String(day),
          callback_data: `rmd|pick|${y}|${two(m + 1)}|${two(day)}`,
        });
        day++;
      } else {
        row.push({ text: " ", callback_data: "rmd|noop" });
      }
    }
    rows.push(row);
  }

  return { text: "📅 Elegí un día", reply_markup: { inline_keyboard: rows } };
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

async function iniciarRecordatorioGuiado(bot, msg) {
  const chatId = msg.chat.id;
  const now = new Date();
  estadosRecordatorio[chatId] = { paso: "cal" };
  const cal = renderCalendar(new Date(now.getFullYear(), now.getMonth(), 1));
  await bot.sendMessage(chatId, cal.text, cal.reply_markup);
}

async function manejarCallbacksRecordatorios(bot, query) {
  const chatId = query.message.chat.id;
  const data = query.data || "";
  if (!/^rmd\|/.test(data)) return false;

  const st = (estadosRecordatorio[chatId] ||= { paso: "cal" });
  const parts = data.split("|");

  if (parts[1] === "nav") {
    let y = Number(parts[2]);
    let mm = Number(parts[3]);
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

  if (parts[1] === "time") {
    st.hora = parts[2] || ""; // "" -> 09:00 por defecto
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

module.exports = {
  estadosRecordatorio,
  iniciarRecordatorioGuiado,
  manejarCallbacksRecordatorios,
  manejarPasosRecordatorio,
};
