const {
  leerCategoriasUsuario,
  asegurarCategoriaUsuario,
} = require("./manejoGastosCategorias");

function normalizarMonto(s) {
  if (!s) return NaN;
  const clean = s.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  return parseFloat(clean);
}

async function manejarMensajeGastos(msg, mensaje, sheets, SPREADSHEET_ID, bot) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName =
    [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
    msg.from.username ||
    `${userId}`;
  const t = mensaje.trim();

  // Formato: "Gaste <monto> en <desc> / <categoria>"
  const regex = /gaste\s+(.+?)\s+en\s+(.+?)\s*\/\s*(.+)/i;
  const m = t.match(regex);
  if (!m) {
    await bot.sendMessage(
      chatId,
      '❌ Formato incorrecto. Usá: "Gaste 3500,50 en almuerzo / comida"'
    );
    return;
  }

  const fecha = new Date().toISOString().split("T")[0];
  const monto = normalizarMonto(m[1]);
  const descripcion = m[2].trim();
  const categoria = m[3].trim();

  if (!isFinite(monto) || monto <= 0) {
    await bot.sendMessage(chatId, "❌ Monto inválido. Probá con 1234,56");
    return;
  }

  // Asegurar categoría del usuario
  await asegurarCategoriaUsuario(
    sheets,
    SPREADSHEET_ID,
    userId,
    userName,
    categoria
  );

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Gastos!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[fecha, userId, userName, monto, descripcion, categoria]],
    },
  });

  await bot.sendMessage(
    chatId,
    `✅ Gasto registrado: $${monto.toFixed(
      2
    )} en "${descripcion}" (${categoria})`
  );
}

// Consulta: "Gastos en <categoria>" o "Gastos total"
async function manejarConsultaGastos(
  msg,
  mensaje,
  sheets,
  SPREADSHEET_ID,
  bot
) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const t = mensaje.trim();

  const matchCat = t.match(/gastos (?:en|de) (.+)/i);
  const pedirTeclado = !matchCat;

  if (pedirTeclado) {
    let categorias = await leerCategoriasUsuario(
      sheets,
      SPREADSHEET_ID,
      userId
    );
    if (!categorias.length) {
      await bot.sendMessage(
        chatId,
        "No tenés categorías todavía. Creá una con /nuevo."
      );
      return;
    }
    categorias = [...categorias, "Total"];
    const keyboard = categorias.map((cat) => [{ text: `Gastos en ${cat}` }]);
    await bot.sendMessage(chatId, "📊 ¿Qué categoría querés ver?", {
      reply_markup: {
        keyboard,
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    });
    return;
  }

  const categoriaBuscada = matchCat[1].trim();
  const valuesResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Gastos!A:F",
  });
  const rows = valuesResp.data.values || [];

  let total = 0;
  if (/^total$/i.test(categoriaBuscada)) {
    for (const r of rows.slice(1)) {
      if (r[1] == userId) {
        const monto = parseFloat(r[3]);
        if (isFinite(monto)) total += monto;
      }
    }
    await bot.sendMessage(chatId, `💸 Tu *total* es *$${total.toFixed(2)}*`, {
      parse_mode: "Markdown",
    });
    return;
  }

  for (const r of rows.slice(1)) {
    if (
      r[1] == userId &&
      (r[5] || "").toLowerCase() === categoriaBuscada.toLowerCase()
    ) {
      const monto = parseFloat(r[3]);
      if (isFinite(monto)) total += monto;
    }
  }

  await bot.sendMessage(
    chatId,
    `💸 Tus gastos en *${categoriaBuscada}* suman *$${total.toFixed(2)}*`,
    { parse_mode: "Markdown" }
  );
}
// obtenerUltimosGastos.js
async function obtenerUltimosGastos(
  msg,
  sheets,
  SPREADSHEET_ID,
  bot,
  limite = 5
) {
  const chatId = msg.chat.id;
  const userId = String(chatId); // usamos el chat.id como identificador

  try {
    // Traigo todas las filas de la hoja "Gastos"
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Gastos!A:F",
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) {
      return bot.sendMessage(chatId, "⚠️ No hay gastos registrados todavía.");
    }

    const data = rows.slice(1); // saco encabezado
    // Filtrar solo los gastos del usuario
    const gastosUsuario = data.filter((fila) => fila[1] === userId);

    if (gastosUsuario.length === 0) {
      return bot.sendMessage(chatId, "📭 Todavía no registraste gastos.");
    }

    const ultimos = gastosUsuario.slice(-limite).reverse();

    let respuesta = "📋 *Tus últimos gastos registrados:*\n\n";
    ultimos.forEach(([fecha, , usuario, monto, descripcion, categoria], i) => {
      respuesta += `#${i + 1} — ${fecha || "📅 sin fecha"}\n💸 $${
        monto || "0"
      } en *${descripcion || "sin desc."}* _(cat: ${
        categoria || "sin cat."
      })_\n\n`;
    });

    return bot.sendMessage(chatId, respuesta, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("❌ Error en obtenerUltimosGastos:", e);
    return bot.sendMessage(chatId, "❌ Error al obtener tus últimos gastos.");
  }
}

module.exports = {
  manejarMensajeGastos,
  manejarConsultaGastos,
  obtenerUltimosGastos,
};
