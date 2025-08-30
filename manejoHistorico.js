// manejoHistoricos.js
const HIST_SHEET = process.env.HIST_SHEET || "Historico";
const TZ_OFFSET = process.env.TIMEZONE_OFFSET || "-03:00"; // ej: -03:00

function two(n) {
  return String(n).padStart(2, "0");
}

function _offsetMinutes(offset) {
  const m = String(offset).match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function nowInOffset(offset) {
  const shift = _offsetMinutes(offset);
  const now = new Date();
  return new Date(now.getTime() + shift * 60 * 1000);
}

function todayISOInOffset(offset) {
  const d = nowInOffset(offset);
  const y = d.getUTCFullYear();
  const m = two(d.getUTCMonth() + 1);
  const day = two(d.getUTCDate());
  return `${y}-${m}-${day}`;
}

function firstDayOfCurrentMonthISO(offset) {
  const d = nowInOffset(offset);
  const y = d.getUTCFullYear();
  const m = two(d.getUTCMonth() + 1);
  return `${y}-${m}-01`;
}

async function getSheetIdByTitle(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const found = (meta.data.sheets || []).find(
    (s) => s.properties.title === title
  );
  return found ? found.properties.sheetId : null;
}

async function ensureHistoricoSheet(sheets, spreadsheetId) {
  let id = await getSheetIdByTitle(sheets, spreadsheetId, HIST_SHEET);
  if (id !== null) return id;

  // Crear hoja
  const add = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: HIST_SHEET } } }],
    },
  });
  id = add.data.replies[0].addSheet.properties.sheetId;

  // Escribir encabezados
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${HIST_SHEET}!A1:G1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          "Fecha",
          "UserID",
          "Usuario",
          "Monto",
          "Descripcion",
          "Categoria",
          "ArchivedAt",
        ],
      ],
    },
  });

  return id;
}

function groupConsecutiveZeroBased(indices) {
  const out = [];
  if (!indices.length) return out;
  indices.sort((a, b) => a - b);
  let start = indices[0],
    prev = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const cur = indices[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    out.push([start, prev + 1]); // end exclusive
    start = prev = cur;
  }
  out.push([start, prev + 1]);
  // invertimos para borrar de abajo hacia arriba
  out.reverse();
  return out;
}

function parseYYYYMMDD(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  return s; // lo usamos como string para comparar lexicográficamente
}

function sum(rows) {
  let t = 0;
  for (const r of rows) {
    const n = parseFloat(r[3]);
    if (isFinite(n)) t += n;
  }
  return t;
}

/**
 * /cambiarmes [hoy]
 * - sin args: archiva todo lo anterior al primer día del mes actual (offset TZ)
 * - con "hoy": archiva todo lo anterior a hoy (offset TZ)
 */
async function cambiarMes(msg, sheets, spreadsheetId, bot, argsText = "") {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const userName =
    [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
    msg.from.username ||
    userId;

  const modo = /\bhoy\b/i.test(argsText) ? "hoy" : "mes";
  const cutoffISO =
    modo === "hoy"
      ? todayISOInOffset(TZ_OFFSET)
      : firstDayOfCurrentMonthISO(TZ_OFFSET);

  // Leer gastos
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Gastos!A:F",
  });
  const rows = resp.data.values || [];
  if (rows.length <= 1) {
    await bot.sendMessage(chatId, "No hay gastos para archivar.");
    return;
  }

  // Filtrar filas del usuario anteriores al cutoff
  const headers = rows[0];
  const body = rows.slice(1);
  const toArchive = [];
  const toDeleteZeroBased = []; // índices de hoja (0-based) a borrar

  body.forEach((r, i) => {
    const fecha = parseYYYYMMDD(r[0]);
    const uid = String(r[1] || "");
    if (!fecha || uid !== userId) return;
    // comparación lexicográfica YYYY-MM-DD
    if (fecha < cutoffISO) {
      toArchive.push(r);
      // fila de hoja: header es row 1 -> zero-based index = (i + 1)
      toDeleteZeroBased.push(i + 1);
    }
  });

  if (!toArchive.length) {
    const msgCut =
      modo === "hoy"
        ? `antes de hoy (${cutoffISO})`
        : `anteriores a ${cutoffISO}`;
    await bot.sendMessage(
      chatId,
      `No encontré gastos ${msgCut} para archivar.`
    );
    return;
  }

  // Asegurar hoja HISTÓRICO
  await ensureHistoricoSheet(sheets, spreadsheetId);

  // Copiar al histórico (agregar ArchivedAt)
  const archivedAt = new Date().toISOString();
  const historicoRows = toArchive.map((r) => [...r, archivedAt]);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${HIST_SHEET}!A:G`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: historicoRows },
  });

  // Borrar en "Gastos" las filas movidas (por rangos)
  const gastosSheetId = await getSheetIdByTitle(
    sheets,
    spreadsheetId,
    "Gastos"
  );
  const ranges = groupConsecutiveZeroBased(toDeleteZeroBased);
  const requests = ranges.map(([startIndex, endIndex]) => ({
    deleteDimension: {
      range: {
        sheetId: gastosSheetId,
        dimension: "ROWS",
        startIndex,
        endIndex,
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  // Resumen
  const total = sum(toArchive);
  const msgCut =
    modo === "hoy"
      ? `previos a hoy (${cutoffISO})`
      : `previos a ${cutoffISO} (mes anterior)`;
  await bot.sendMessage(
    chatId,
    `📦 *Archivados ${toArchive.length} gastos* ${msgCut}.\n` +
      `💵 Importe movido: *$${total.toFixed(2)}*\n` +
      `📄 Hoja: *${HIST_SHEET}*`,
    { parse_mode: "Markdown" }
  );
}

module.exports = { cambiarMes };
