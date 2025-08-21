const {
  leerCategoriasUsuario,
  asegurarCategoriaUsuario,
} = require("./manejoGastosCategorias");

const estadosConversacion = {};
function normalizarMonto(s) {
  if (!s) return NaN;
  const clean = s.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  return parseFloat(clean);
}

async function iniciarNuevoGastoConversacional(
  bot,
  msg,
  sheets,
  SPREADSHEET_ID
) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const categorias = await leerCategoriasUsuario(
    sheets,
    SPREADSHEET_ID,
    userId
  );

  if (!categorias.length) {
    estadosConversacion[chatId] = {
      paso: "cat_nueva",
      datos: {},
      categorias: [],
    };
    await bot.sendMessage(
      chatId,
      "❗ No tenés categorías. Escribí el nombre de tu primera categoría:"
    );
    return;
  }

  estadosConversacion[chatId] = { paso: "cat", datos: {}, categorias };
  const keyboard = categorias.map((c) => [{ text: c }]);
  keyboard.push([{ text: "➕ Nueva categoría" }]);
  await bot.sendMessage(
    chatId,
    "📂 ¿En qué categoría fue el gasto?\n(Usá /cancel para cancelar)",
    {
      reply_markup: {
        keyboard,
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    }
  );
}

async function manejarPasosConversacion(bot, msg, sheets, SPREADSHEET_ID) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName =
    [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
    msg.from.username ||
    `${userId}`;
  const texto = (msg.text || "").trim();
  const st = estadosConversacion[chatId];
  if (!st) return;

  switch (st.paso) {
    case "cat": {
      if (texto === "➕ Nueva categoría") {
        st.paso = "cat_nueva";
        await bot.sendMessage(
          chatId,
          "✍️ Escribí el nombre de la nueva categoría:"
        );
        return;
      }
      if (!st.categorias.includes(texto)) {
        await bot.sendMessage(
          chatId,
          "❌ Elegí una de la lista o agregá nueva."
        );
        return;
      }
      st.datos.categoria = texto;
      st.paso = "desc";
      await bot.sendMessage(chatId, "📝 ¿Qué compraste?");
      break;
    }

    case "cat_nueva": {
      const nueva = texto;
      if (!nueva || nueva.length < 2) {
        await bot.sendMessage(chatId, "❌ Nombre inválido. Probá con otro.");
        return;
      }
      await asegurarCategoriaUsuario(
        sheets,
        SPREADSHEET_ID,
        userId,
        userName,
        nueva
      );
      st.categorias.push(nueva);
      st.datos.categoria = nueva;
      st.paso = "desc";
      await bot.sendMessage(
        chatId,
        `✅ Categoría "${nueva}" agregada.\n📝 ¿Qué compraste?`
      );
      break;
    }

    case "desc": {
      if (!texto || texto.length < 2) {
        await bot.sendMessage(chatId, "❌ Escribí una descripción válida.");
        return;
      }
      st.datos.descripcion = texto;
      st.paso = "monto";
      await bot.sendMessage(chatId, "💸 ¿Cuánto gastaste?");
      break;
    }

    case "monto": {
      const monto = normalizarMonto(texto);
      if (!isFinite(monto) || monto <= 0) {
        await bot.sendMessage(chatId, "❌ Monto inválido. Probá con 1234,56");
        return;
      }
      st.datos.monto = parseFloat(monto.toFixed(2));
      st.paso = "confirmar";
      const { categoria, descripcion } = st.datos;
      await bot.sendMessage(
        chatId,
        `🧾 *Confirmá*: $${st.datos.monto.toFixed(
          2
        )} — "${descripcion}" (${categoria})`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            keyboard: [[{ text: "✅ Confirmar" }], [{ text: "❌ Cancelar" }]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        }
      );
      break;
    }

    case "confirmar": {
      if (/^✅ Confirmar$/.test(texto)) {
        const fecha = new Date().toISOString().split("T")[0];
        const { monto, descripcion, categoria } = st.datos;
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
          )} en "${descripcion}" (${categoria})`,
          {
            reply_markup: { remove_keyboard: true },
          }
        );
        delete estadosConversacion[chatId];
        return;
      }
      if (/^❌ Cancelar$/.test(texto)) {
        await bot.sendMessage(chatId, "🚫 Gasto cancelado.", {
          reply_markup: { remove_keyboard: true },
        });
        delete estadosConversacion[chatId];
        return;
      }
      await bot.sendMessage(chatId, "Tocá *Confirmar* o *Cancelar*.", {
        parse_mode: "Markdown",
      });
      break;
    }
  }
}

module.exports = {
  iniciarNuevoGastoConversacional,
  manejarPasosConversacion,
  estadosConversacion,
};
