// helpersCategorias.js

function _clean(vals) {
  return (vals?.flat() || []).map((s) => String(s).trim()).filter(Boolean);
}

function _nowISO() {
  return new Date().toISOString();
}

// Lee categorías activas del usuario desde la hoja Categorias.
// Si no hay, intenta deducirlas de Gastos!A:F (col F = categoría) del propio usuario.
async function leerCategoriasUsuario(sheets, SPREADSHEET_ID, userId) {
  // 1) Categorias!A:E
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Categorias!A:E",
    });
    const rows = r.data.values || [];
    const out = [];
    const seen = new Set();

    for (const row of rows.slice(1)) {
      const [uid, , cat, activo] = row;
      if (String(uid) === String(userId) && (activo ?? "1") !== "0") {
        const key = (cat || "").trim().toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(cat.trim());
        }
      }
    }
    if (out.length) return out;
  } catch (_) {}

  // 2) Deducir de Gastos!A:F (col 1 = UserID, col 5 = Categoría)
  try {
    const r2 = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Gastos!A:F",
    });
    const rows2 = r2.data.values || [];
    const set = new Set();

    for (const row of rows2.slice(1)) {
      const uid = row[1];
      const cat = (row[5] || "").trim();
      if (String(uid) === String(userId) && cat) set.add(cat);
    }
    return Array.from(set);
  } catch (_) {}

  return [];
}

// Agrega una categoría para el usuario si no existe (case-insensitive)
async function asegurarCategoriaUsuario(
  sheets,
  SPREADSHEET_ID,
  userId,
  userName,
  categoria
) {
  const lista = await leerCategoriasUsuario(sheets, SPREADSHEET_ID, userId);
  if (lista.map((x) => x.toLowerCase()).includes(categoria.toLowerCase()))
    return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Categorias!A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[String(userId), userName || "", categoria, 1, _nowISO()]],
    },
  });
}

module.exports = {
  leerCategoriasUsuario,
  asegurarCategoriaUsuario,
};
