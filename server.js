/**
 * API DE GESTIÓN Y SINCRONIZACIÓN - DESPLIEGUE EN HOSTINGER/DOCKER
 * Centraliza el flujo de datos entre Webhooks, SQLite y Google Sheets.
 * Ahora configurado para leer credenciales desde variables de entorno (.env).
 */



require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(express.json());

// IDs de Documentos de Google (Pueden venir de .env o usar los default)
const SOURCE_SPREADSHEET_ID = process.env.SOURCE_SPREADSHEET_ID || '1KmhO5eGKGy-eTFFHSYaT3ZFO11dp2LyODua_Efvqd6I';
const TARGET_SPREADSHEET_ID = process.env.TARGET_SPREADSHEET_ID || '1UV3FePqn1fcEKJj7U1KajiwOgWuFkcuV09_-3M47pHk';

///////////
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!require('fs').existsSync(DATA_DIR)) {
    require('fs').mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'enlace.db');

// Si no hay API_KEY definida en .env, se desactiva la validación para facilitar la integración inicial
const API_KEY = process.env.WEBHOOK_API_KEY || null;

// --- INICIALIZACIÓN DE DB ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error("Error al abrir SQLite:", err.message);
    else {
        console.log(`Conectado a SQLite en: ${DB_PATH}`);
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

        db.run(`CREATE TABLE IF NOT EXISTS id_reportes (
            folio_r TEXT PRIMARY KEY, 
            nombre TEXT, 
            telefono TEXT, 
            fecha_cita_lograda TEXT
        )`);
    });
}

// --- MIDDLEWARE DE SEGURIDAD ---
const authenticate = (req, res, next) => {
    if (!API_KEY) return next(); // Si no hay clave configurada, permite el paso
    const key = req.headers['x-api-key'];
    if (key && key === API_KEY) return next();
    res.status(401).send("No autorizado");
};

// --- UTILIDADES ---
function normalizePhone(phone) {
    return phone ? String(phone).replace(/\s+/g, '').trim() : '';
}

function getFolioNumber(folioStr) {
    if (!folioStr) return 0;
    const match = String(folioStr).match(/^\d+/);
    return match ? parseInt(match[0], 10) : 0;
}

// --- RUTAS ---

/**
 * Webhook para AGENDA (Compatible con /api/webhook y /api/webhook/agenda)
 */
const handleAgendaWebhook = (req, res) => {
    const d = req.body;
    const phone = normalizePhone(d.telefono);
    const folioNum = getFolioNumber(d.folio_ingreso);

    if (!phone) return res.status(400).send("Teléfono requerido");

    // Si el webhook no envía fechas, usamos las del servidor para el registro inicial
    const now = new Date();
    const serverFecha = now.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });
    const serverHora = now.toLocaleTimeString('es-MX', { hour12: false, timeZone: 'America/Mexico_City' });

    const sql = `
        INSERT INTO agenda (
            folio_ingreso, nombre, telefono, status, comentarios, 
            hora_ingreso_meta, fecha_ingreso_meta, folio_num
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(telefono) DO UPDATE SET
            folio_ingreso = excluded.folio_ingreso,
            nombre = excluded.nombre,
            status = excluded.status,
            comentarios = excluded.comentarios,
            folio_num = excluded.folio_num
        WHERE excluded.folio_num > agenda.folio_num
    `;

    db.run(sql, [
        d.folio_ingreso, d.nombre, phone, d.status, d.comentarios,
        d.hora_ingreso_meta || serverHora, d.fecha_ingreso_meta || serverFecha, folioNum
    ], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(200).json({ message: "OK", id: phone });
    });
};

app.post('/api/webhook', authenticate, handleAgendaWebhook);
app.post('/api/webhook/agenda', authenticate, handleAgendaWebhook);

/**
 * Webhook para REPORTES (Folios R)
 */
app.post('/api/webhook/reportes', authenticate, (req, res) => {
    const d = req.body;
    const phone = normalizePhone(d.telefono);
    if (!phone || !d.folio_r) return res.status(400).send("Teléfono y Folio R requeridos");

    const sql = `INSERT INTO id_reportes (folio_r, nombre, telefono, fecha_cita_lograda) 
                 VALUES (?, ?, ?, ?) ON CONFLICT(folio_r) DO UPDATE SET fecha_cita_lograda = excluded.fecha_cita_lograda`;

    db.run(sql, [d.folio_r, d.nombre, phone, d.fecha_cita_lograda], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(200).send("Reporte guardado");
    });
});

/**
 * Endpoints de Lectura
 */
app.get('/api/agenda', (req, res) => {
    db.all("SELECT * FROM agenda ORDER BY folio_num DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/agenda/:telefono', (req, res) => {
    const phone = normalizePhone(req.params.telefono);
    db.get("SELECT * FROM agenda WHERE telefono = ?", [phone], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).send("No encontrado");
        res.json(row);
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