require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { google } = require("googleapis");

// === HANDLERS ===
const {
  manejarMensajeGastos,
  manejarConsultaGastos,
  obtenerUltimosGastos,
} = require("./manejoGastos.js");

const {
  iniciarNuevoGastoConversacional,
  manejarPasosConversacion,
  estadosConversacion,
} = require("./manejoGastosConversacion.js");

const { cambiarMes } = require("./manejoHistorico.js");

const {
  manejarRecordatorio,
  listarRecordatorios,
  runRemindersOnce,
} = require("./manejoRecordatorios.js");

const {
  estadosRecordatorio,
  iniciarRecordatorioGuiado,
  manejarCallbacksRecordatorios,
  manejarPasosRecordatorio,
} = require("./manejoRecordatoriosCalendario.js");

// === GOOGLE SHEETS ===
function getGoogleCredentials() {
  const b64 = process.env.GOOGLE_CREDENTIALS_JSON_BASE64;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (b64) return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (raw) return JSON.parse(raw);
  try {
    return require("./credentials.json");
  } catch {
    throw new Error(
      "No Google credentials found. Set GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_JSON_BASE64."
    );
  }
}

const credentials = getGoogleCredentials();
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID || "1o1X0CUdi3FaOM0LqhqCGmltnlIzJOHWITaqslCBP6MI";

// === TELEGRAM BOT + SERVER ===
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();

if (!TOKEN) {
  throw new Error("TELEGRAM_TOKEN no configurado en variables de entorno.");
}

const app = express();
app.use(express.json());

// Healthcheck
app.get("/", (_req, res) => res.status(200).send("Bot de gastos activo ✅"));

// Arranca Express siempre (webhook o polling)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Express escuchando en puerto ${PORT}`));

let bot;

if (PUBLIC_URL) {
  // === MODO WEBHOOK (prod) ===
  bot = new TelegramBot(TOKEN);
  const webhookPath = `/bot${TOKEN}`;
  const webhookUrl = `${PUBLIC_URL}${webhookPath}`;

  bot
    .setWebHook(webhookUrl)
    .then(() => console.log("✅ Webhook configurado:", webhookUrl))
    .catch((e) => console.error("setWebHook error:", e?.message || e));

  app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
} else {
  // === MODO POLLING (dev) ===
  bot = new TelegramBot(TOKEN, { polling: true });
  bot
    .deleteWebHook({ drop_pending_updates: false })
    .then(() => console.log("✅ Usando POLLING (sin PUBLIC_URL)"))
    .catch((e) => console.error("deleteWebHook error:", e?.message || e));
}

// === CRON ===
app.get("/run-reminders", async (req, res) => {
  const key = process.env.REMINDERS_CRON_KEY || "";
  if (key && req.query.key !== key) return res.status(403).send("forbidden");
  try {
    const n = await runRemindersOnce(bot, sheets, SPREADSHEET_ID);
    res.status(200).send(`OK ${n}`);
  } catch (e) {
    res.status(500).send(`ERR ${e.message}`);
  }
});

// === HELP ===
function mensajeAyuda(chatId) {
  return bot.sendMessage(
    chatId,
    `
📌 *Comandos*

🧭 *Gasto guiado*:
/nuevo  (registrar gastos)

📊 *Consultar*:
/gastos (ver gastos en una categoria)
/ultimos (ver últimos gastos)

⏭ *Cierre de mes*:
/cambiarmes  (mueve todos los gastos del mes anterior al historico)
/cambiarmeshoy  (mueve todos los gastos previos a hoy al historico)

⏰ *Recordatorios*:
/recordar  (registra un evento)
/recordatorios  (lista próximos eventos)

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
  if (t === "/ultimos") return "gastos_ultimos";
  if (t === "/gastos") return "gastos_consulta";
  if (t === "/recordatorios") return "recordatorios_listar";
  if (t === "/cancel") return "cancelar";
  if (t === "/recordar") return "recordatorio_guiado";
  if (t === "/cambiarmes") return "cambiar_mes";
  if (t === "/cambiarmeshoy") return "cambiar_mes_hoy";

  if (/^gaste\s+/i.test(t)) return "gasto_rapido";
  if (/^gastos(\s|$)/i.test(t)) return "gastos_consulta";
  if (/^recordar\s+/i.test(t)) return "recordatorio_alta";

  return "desconocido";
}

// === CALLBACKS del minicalendario ===
bot.on("callback_query", async (q) => {
  try {
    const handled = await manejarCallbacksRecordatorios(bot, q);
    if (!handled) return;
  } catch (e) {
    console.error("callback_query error:", e?.message || e);
  }
});

// === ROUTER PRINCIPAL ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const texto = msg.text || "";
  const intencion = detectarIntencion(texto);

  try {
    // Si está en flujo de GASTOS conversacional
    if (estadosConversacion[chatId]) {
      if (intencion === "cancelar") {
        delete estadosConversacion[chatId];
        await bot.sendMessage(chatId, "🚫 Flujo cancelado.", {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      await manejarPasosConversacion(bot, msg, sheets, SPREADSHEET_ID);
      return;
    }

    // Si está en flujo de RECORDATORIO (después de elegir fecha/hora)
    if (estadosRecordatorio[chatId]) {
      if (intencion === "cancelar") {
        delete estadosRecordatorio[chatId];
        await bot.sendMessage(chatId, "🚫 Recordatorio cancelado.");
        return;
      }
      const handled = await manejarPasosRecordatorio(
        bot,
        msg,
        sheets,
        SPREADSHEET_ID
      );
      if (handled) return;
    }

    // Ruteo por intención
    switch (intencion) {
      case "ayuda":
        return mensajeAyuda(chatId);

      case "cambiar_mes": {
        return cambiarMes(msg, sheets, SPREADSHEET_ID, bot, args);
      }

      case "cambiar_mes_hoy": {
        return cambiarMes(msg, sheets, SPREADSHEET_ID, bot, "hoy");
      }

      case "gasto_conversacional":
        return iniciarNuevoGastoConversacional(
          bot,
          msg,
          sheets,
          SPREADSHEET_ID
        );

      case "gasto_rapido":
        return manejarMensajeGastos(msg, texto, sheets, SPREADSHEET_ID, bot);

      case "gastos_ultimos":
        return obtenerUltimosGastos(msg, sheets, SPREADSHEET_ID, bot, 5);

      case "gastos_consulta":
        return manejarConsultaGastos(msg, texto, sheets, SPREADSHEET_ID, bot);

      case "recordatorio_alta":
        return manejarRecordatorio(msg, texto, sheets, SPREADSHEET_ID, bot);

      case "recordatorios_listar":
        return listarRecordatorios(msg, sheets, SPREADSHEET_ID, bot);

      case "recordatorio_guiado":
        return iniciarRecordatorioGuiado(bot, msg);

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
//ver grafs
