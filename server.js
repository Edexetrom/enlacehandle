/**
 * API DE GESTIÓN Y SINCRONIZACIÓN - DESPLIEGUE EN HOSTINGER/DOCKER
 * Centraliza el flujo de datos entre Webhooks, SQLite y Google Sheets.
 * Ahora configurado para leer credenciales desde variables de entorno (.env).
 */

require('dotenv').config(); // Carga variables desde .env si existe (útil para desarrollo local)
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(express.json());

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'enlace.db');

// IDs de Documentos de Google (Pueden venir de .env o usar los default)
const SOURCE_SPREADSHEET_ID = process.env.SOURCE_SPREADSHEET_ID || '1KmhO5eGKGy-eTFFHSYaT3ZFO11dp2LyODua_Efvqd6I';
const TARGET_SPREADSHEET_ID = process.env.TARGET_SPREADSHEET_ID || '1UV3FePqn1fcEKJj7U1KajiwOgWuFkcuV09_-3M47pHk';

// --- CONFIGURACIÓN DE AUTH DE GOOGLE ---
let auth;
try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        // Si las credenciales están en una variable de entorno como string JSON
        const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        console.log("Autenticación configurada mediante variable de entorno.");
    } else {
        // Fallback a archivo físico si no hay variable de entorno
        const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
        auth = new google.auth.GoogleAuth({
            keyFile: CREDENTIALS_PATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        console.log("Autenticación configurada mediante archivo credentials.json.");
    }
} catch (error) {
    console.error("Error configurando la autenticación de Google:", error.message);
}

// --- INICIALIZACIÓN DE BASE DE DATOS ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error("Error al abrir SQLite:", err.message);
    else {
        console.log(`Conectado a SQLite: ${DB_PATH}`);
        initTables();
    }
});

function initTables() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS agenda (
            folio_ingreso TEXT, nombre TEXT, telefono TEXT PRIMARY KEY, status TEXT,
            comentarios TEXT, hora_ingreso_meta TEXT, fecha_ingreso_meta TEXT,
            fecha_cita_lograda TEXT, fecha_de_asesoria TEXT, hora_cita TEXT,
            asesor TEXT, quien_agendo TEXT, region TEXT, valoracion TEXT,
            quien_envio TEXT, ultima_fecha_contacto TEXT, veces_contactado TEXT,
            folios_r TEXT, folio_num INTEGER
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS reportes (
            folio_r TEXT, nombre TEXT, telefono TEXT, fecha_cita_lograda TEXT
        )`);
    });
}

// --- UTILIDADES ---
function normalizePhone(phone) {
    return phone ? String(phone).replace(/\s+/g, '').trim() : '';
}

function getFolioNumber(folioStr) {
    if (!folioStr) return 0;
    const match = String(folioStr).match(/^\d+/);
    return match ? parseInt(match[0], 10) : 0;
}

// --- RUTAS DE LA API ---

app.post('/api/webhook', (req, res) => {
    const data = req.body;
    const phone = normalizePhone(data.telefono);
    const folioNum = getFolioNumber(data.folio_ingreso);

    if (!phone) return res.status(400).send("Teléfono requerido");

    const sql = `INSERT INTO agenda (
        folio_ingreso, nombre, telefono, status, comentarios, folio_num
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telefono) DO UPDATE SET
        folio_ingreso = excluded.folio_ingreso,
        nombre = excluded.nombre,
        status = excluded.status,
        comentarios = excluded.comentarios,
        folio_num = excluded.folio_num
    WHERE excluded.folio_num > agenda.folio_num`;

    db.run(sql, [
        data.folio_ingreso, data.nombre, phone, data.status, data.comentarios, folioNum
    ], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(200).send("Datos procesados correctamente");
    });
});

app.get('/health', (req, res) => res.send("API Online"));

// --- LÓGICA DE SINCRONIZACIÓN CON GOOGLE SHEETS ---

/*async function syncToSheets() {
    if (!auth) {
        console.error("No se puede sincronizar: Autenticación no configurada.");
        return;
    }

    console.log(`[${new Date().toLocaleTimeString()}] Sincronizando...`);

    try {
        const sheets = google.sheets({ version: 'v4', auth });

        const rows = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM agenda ORDER BY folio_num ASC", (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });

        if (rows.length === 0) return;

        const values = rows.map(r => [
            "", "", r.folio_ingreso, r.nombre, "", r.telefono, r.status,
            r.comentarios, r.hora_ingreso_meta, r.fecha_ingreso_meta,
            r.fecha_cita_lograda, r.fecha_de_asesoria, r.hora_cita,
            r.asesor, r.quien_agendo, r.region, r.valoracion,
            r.quien_envio, r.ultima_fecha_contacto, r.veces_contactado, r.folios_r
        ]);

        values.unshift(["", "", "FOLIO", "NOMBRE", "", "TELÉFONO", "STATUS", "COMENTARIOS", "HORA", "FECHA", "CITA LOGRADA", "ASESORÍA", "HORA CITA", "ASESOR", "AGENDÓ", "REGIÓN", "VALORACIÓN", "ENVÍO", "ULT_CONTACTO", "VECES", "FOLIOS R"]);

        await sheets.spreadsheets.values.update({
            spreadsheetId: TARGET_SPREADSHEET_ID,
            range: "'Hoja 1'!A1",
            valueInputOption: 'USER_ENTERED',
            requestBody: { values },
        });

        console.log("✓ Sincronización exitosa.");
    } catch (error) {
        console.error("X Error en sincronización:", error.message);
    }
} 

setInterval(syncToSheets, 30000);*/

app.listen(PORT, () => {
    console.log(`Servidor API corriendo en puerto ${PORT}`);
    //syncToSheets();
});