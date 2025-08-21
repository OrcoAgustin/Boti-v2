require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const {
  manejarMensajeGastos,
  manejarConsultaGastos,
} = require("./manejarGastos");
const {
  iniciarNuevoGastoConversacional,
  manejarPasosConversacion,
  estadosConversacion,
} = require("./manejoGastosConversacion");
const {
  manejarRecordatorio,
  listarRecordatorios,
} = require("./manejoRecordatorios");

// === GOOGLE SHEETS ===
const credentials = require("./credentials.json");
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = "1o1X0CUdi3FaOM0LqhqCGmltnlIzJOHWITaqslCBP6MI";

// === TELEGRAM BOT ===
const express = require("express");
const app = express();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
bot.setWebHook(`${process.env.PUBLIC_URL}/bot${process.env.TELEGRAM_TOKEN}`);

app.use(express.json());

app.post(`/bot${process.env.TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot de gastos activo ✅");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor express escuchando");
});

// === HELP ===
function mensajeAyuda(chatId) {
  return bot.sendMessage(
    chatId,
    `
📌 *Comandos*

💸 *Gasto rápido*:
"Gaste 3500 en almuerzo / comida"

🧭 *Gasto guiado*:
/nuevo  (con botones)

📊 *Consultar*:
"Gastos en comida"  |  "Gastos total"  |  /gastos

⏰ *Recordatorios*:
"Recordar 2025-08-30 10:00 pagar alquiler"
/recordatorios  (lista próximos)

❌ *Cancelar flujo*:
/cancel
`,
    { parse_mode: "Markdown" }
  );
}

// === DETECCIÓN DE INTENCIÓN ===
function detectarIntencion(texto) {
  if (!texto) return "desconocido";
  const t = texto.trim();

  if (t.startsWith("/start") || t.toLowerCase().startsWith("ayuda"))
    return "ayuda";
  if (t === "/nuevo") return "gasto_conversacional";
  if (t === "/gastos") return "gastos_consulta";
  if (t === "/recordatorios") return "recordatorios_listar";
  if (t === "/cancel") return "cancelar";

  if (/^gaste\s+/i.test(t)) return "gasto_rapido";
  if (/^gastos(\s|$)/i.test(t)) return "gastos_consulta";
  if (/^recordar\s+/i.test(t)) return "recordatorio_alta";

  return "desconocido";
}

// === ROUTER PRINCIPAL ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const texto = msg.text || "";
  const intencion = detectarIntencion(texto);

  try {
    // Si está en un flujo conversacional activo…
    if (estadosConversacion[chatId]) {
      if (intencion === "cancelar") {
        delete estadosConversacion[chatId];
        await bot.sendMessage(chatId, "🚫 Flujo cancelado.", {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      // Continuar flujo guiado
      await manejarPasosConversacion(bot, msg, sheets, SPREADSHEET_ID);
      return;
    }

    // Ruteo por intención
    switch (intencion) {
      case "ayuda":
        return mensajeAyuda(chatId);

      case "gasto_conversacional":
        return iniciarNuevoGastoConversacional(
          bot,
          msg,
          sheets,
          SPREADSHEET_ID
        );

      case "gasto_rapido":
        return manejarMensajeGastos(msg, texto, sheets, SPREADSHEET_ID, bot);

      case "gastos_consulta":
        return manejarConsultaGastos(msg, texto, sheets, SPREADSHEET_ID, bot);

      case "recordatorio_alta":
        return manejarRecordatorio(msg, texto, sheets, SPREADSHEET_ID, bot);

      case "recordatorios_listar":
        return listarRecordatorios(msg, sheets, SPREADSHEET_ID, bot);

      default:
        return bot.sendMessage(
          chatId,
          "❓ No entendí. Escribí /start para ver comandos."
        );
    }
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, "❌ Ocurrió un error procesando tu mensaje.");
  }
});

console.log("🤖 Bot v2 iniciado");
