const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const https = require('https');
const { setupDatabase } = require('./database');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const SECRET_KEY = 'techfoods_key_2024';

app.use(cors());
app.use(express.json());

let db;

//probando que este funcionando el repositorio

// ==========================================
// CONFIGURACIÓN iDEMPIERE / LIRION (Postgres)
// ==========================================
const poolIdempiere = new Pool({
    user: 'adempiere',
    host: '192.168.3.80',
    database: 'techfoods09022026',  //db prueba = techfoods09022026   db producción = liriontechfoods
    password: 'adempiere',
    port: 5432,
    max: 5,
    idleTimeoutMillis: 3000,
    connectionTimeoutMillis: 2000
});

poolIdempiere.on('error', (err, client) => {
    console.error('⚠️ Advertencia Lirion:', err.message);
});

setupDatabase(poolIdempiere).then(async database => {
    db = database;
    
    // Crear tabla de configuración global y predefinir valores
    await db.run(`
        CREATE TABLE IF NOT EXISTS configuracion (
            clave VARCHAR(100) PRIMARY KEY,
            valor TEXT NOT NULL
        )
    `);
    await db.run("INSERT IGNORE INTO configuracion (clave, valor) VALUES ('allow_server_change', 'true')");
    await db.run("INSERT IGNORE INTO configuracion (clave, valor) VALUES ('default_server', 'test')");

    const PORT = 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor de Producción listo en http://localhost:${PORT}`);
        console.log(`🔗 Puente con iDempiere configurado en 192.168.3.80`);
    });
});

// ==========================================
// FUNCIÓN AUXILIAR: FECHAS SEGURAS PARA MYSQL
// ==========================================
const WAREHOUSE_PRODUCCION_ID = 1000002; // Bodega de Producción: stock operativo para planta y supervisor
const WAREHOUSE_ORIGEN_INSUMOS_ID = 1000000; // Bodega origen para abastecer Producción en solicitudes de insumos
const DOCTYPE_SOLICITUD_INSUMOS_ID = 1000504; // Tipo documento usado por Lirion para Solicitud de Insumos / Movimiento interno

const toMySQLDate = (val) => {
    if (!val) return null;

    const d = new Date(val);
    if (isNaN(d.getTime())) return null;

    const pad = (n) => String(n).padStart(2, '0');

    // Usa hora local del servidor, NO UTC.
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function esperarMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


// ==========================================
// HELPERS USUARIO LIRION
// ==========================================
function extraerTokenLirion(body = {}) {
    return body?.token ||
        body?.access_token ||
        body?.jwt ||
        body?.data?.token ||
        body?.data?.access_token ||
        body?.result?.token ||
        body?.result?.access_token ||
        null;
}

function extraerAdUserIdDesdeRespuestaLirion(body = {}) {
    const posibles = [
        body?.ad_user_id,
        body?.AD_User_ID,
        body?.adUserId,
        body?.userId,
        body?.user_id,
        body?.id,
        body?.data?.ad_user_id,
        body?.data?.AD_User_ID,
        body?.data?.adUserId,
        body?.data?.userId,
        body?.data?.user_id,
        body?.data?.id,
        body?.user?.ad_user_id,
        body?.user?.AD_User_ID,
        body?.user?.id,
        body?.result?.ad_user_id,
        body?.result?.AD_User_ID,
        body?.result?.userId,
        body?.result?.id
    ];

    for (const valor of posibles) {
        const n = Number(valor);
        if (Number.isFinite(n) && n > 0) return n;
    }

    return null;
}

async function buscarUsuarioLirionPorUsername(clientOrPool, username) {
    if (!username) return null;

    const result = await clientOrPool.query(`
        SELECT ad_user_id, value, name, title, description, email, ldapuser
        FROM adempiere.ad_user
        WHERE isactive = 'Y'
          AND (
              LOWER(COALESCE(ldapuser, '')) = LOWER($1)
              OR LOWER(COALESCE(value, '')) = LOWER($1)
              OR LOWER(COALESCE(email, '')) = LOWER($1)
              OR LOWER(COALESCE(name, '')) = LOWER($1)
          )
        ORDER BY updated DESC, created DESC
        LIMIT 1
    `, [username]);

    return result.rows[0] || null;
}

async function resolverCreadorLirionDesdeRequest(req, clientOrPool) {
    const idJwt = Number(req.user?.adempiere_user_id);
    if (Number.isFinite(idJwt) && idJwt > 0) return idJwt;

    const idTokenLirion = Number(req.user?.lirion_ad_user_id);
    if (Number.isFinite(idTokenLirion) && idTokenLirion > 0) return idTokenLirion;

    const username = req.user?.username;
    const usuarioLirion = await buscarUsuarioLirionPorUsername(clientOrPool, username);
    if (usuarioLirion?.ad_user_id) return Number(usuarioLirion.ad_user_id);

    throw new Error('No se pudo determinar el AD_User_ID de Lirion para el usuario autenticado. Cierre sesión e ingrese nuevamente.');
}

// ==========================================
// AUTENTICACIÓN PMS + HELPERS API LIRION
// ==========================================
function autenticarPMS(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (!token) {
        return res.status(401).json({ error: 'Token no enviado' });
    }

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

function autenticarPMSOpcional(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();

    req.user = null;

    if (!token) {
        return next();
    }

    try {
        req.user = jwt.verify(token, SECRET_KEY);
    } catch (err) {
        console.warn('⚠️ Token PMS inválido o expirado. Se intentará usar adempiere_user_id enviado desde el frontend.');
        req.user = null;
    }

    next();
}

function httpsJsonRequest({ hostname, port, path, method = 'POST', token = null, body = null, serverType = 'test' }) {
    let authHeader = token;
    if (token && !token.startsWith('Bearer ')) {
        authHeader = `Bearer ${token}`;
    }

    const targetPort = port || (serverType === 'real' ? 8450 : 8452);

    const options = {
        hostname: hostname || '192.168.3.80',
        port: targetPort,
        path,
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(authHeader ? { Authorization: authHeader } : {})
        },
        rejectUnauthorized: false
    };

    const data = body ? JSON.stringify(body) : null;
    if (data && method !== 'GET') {
        options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    return new Promise((resolve, reject) => {
        const reqApi = https.request(options, (resApi) => {
            let responseData = '';

            resApi.on('data', chunk => {
                responseData += chunk;
            });

            resApi.on('end', () => {
                let parsed = {};

                try {
                    parsed = responseData ? JSON.parse(responseData) : {};
                } catch (e) {
                    parsed = { raw: responseData };
                }

                if (resApi.statusCode >= 200 && resApi.statusCode < 300) {
                    resolve(parsed);
                } else {
                    const mensaje = parsed?.error || parsed?.detail || parsed?.message || parsed?.raw || `HTTP ${resApi.statusCode}`;
                    const error = new Error(mensaje);
                    error.statusCode = resApi.statusCode;
                    error.responseBody = parsed;
                    reject(error);
                }
            });
        });

        reqApi.on('error', reject);
        if (data && method !== 'GET') reqApi.write(data);
        reqApi.end();
    });
}

async function obtenerTokenLirionDesdeCredenciales(username, password) {
    if (!username || !password) return null;

    try {
        const resRaw = await httpsJsonRequest({
            hostname: '192.168.3.80', port: 8452, path: '/api/v1/auth/tokens', method: 'POST',
            body: { userName: username, password }
        });

        if (!resRaw.token || !resRaw.clients || !resRaw.clients.length) return null;
        const rawToken = resRaw.token;
        const clientId = resRaw.clients[0].id;

        const resRoles = await httpsJsonRequest({
            hostname: '192.168.3.80', port: 8452, path: `/api/v1/auth/roles?client=${clientId}`, method: 'GET', token: rawToken
        });
        if (!resRoles.roles || !resRoles.roles.length) return null;
        const roleId = resRoles.roles[0].id;

        const resOrgs = await httpsJsonRequest({
            hostname: '192.168.3.80', port: 8452, path: `/api/v1/auth/organizations?client=${clientId}&role=${roleId}`, method: 'GET', token: rawToken
        });
        if (!resOrgs.organizations || !resOrgs.organizations.length) return null;
        const orgId = resOrgs.organizations[0].id;

        const resWhs = await httpsJsonRequest({
            hostname: '192.168.3.80', port: 8452, path: `/api/v1/auth/warehouses?client=${clientId}&role=${roleId}&organization=${orgId}`, method: 'GET', token: rawToken
        });
        if (!resWhs.warehouses || !resWhs.warehouses.length) return null;
        const warehouseId = resWhs.warehouses[0].id;

        const resFinal = await httpsJsonRequest({
            hostname: '192.168.3.80', port: 8452, path: '/api/v1/auth/tokens', method: 'POST',
            body: {
                userName: username, password,
                parameters: { clientId, roleId, organizationId: orgId, warehouseId, language: 'es_CL' }
            }
        });

        return extraerTokenLirion(resFinal);
    } catch (e) {
        console.error("Error obteniendo token completo de respaldo:", e.message);
        return null;
    }
}

async function obtenerTokenLirionParaCompletar(req) {
    // Normalmente viene dentro del JWT PMS generado al iniciar sesión contra Lirion.
    if (req.user?.lirion_token) return req.user.lirion_token;

    // Respaldo opcional para ambientes productivos: definir variables de entorno en el backend.
    // No se usa si no están configuradas, para no cambiar el usuario/auditoría sin control.
    const serviceUser = process.env.LIRION_API_USER || process.env.IDEMPIERE_API_USER;
    const servicePass = process.env.LIRION_API_PASSWORD || process.env.IDEMPIERE_API_PASSWORD;

    if (serviceUser && servicePass) {
        return await obtenerTokenLirionDesdeCredenciales(serviceUser, servicePass);
    }

    return null;
}

async function procesarProduccionEnLirionConUsuario(mProductionId, lirionToken) {
    if (!lirionToken) {
        throw new Error('No hay token REST activo de Lirion para completar la OP. Cierre sesión e ingrese nuevamente para generar un token con contexto de cliente/rol/organización.');
    }

    if (!mProductionId) {
        throw new Error('No se recibió el ID de la orden de producción para completar en Lirion.');
    }

    // Mismo patrón que el script CrearFacturas.py del equipo:
    // actualizar el modelo por REST enviando "doc-action" para que iDempiere ejecute
    // el proceso interno del documento, igual que al presionar Completar en Lirion.
    return await httpsJsonRequest({
        hostname: '192.168.3.80',
        port: 8452,
        path: `/api/v1/models/m_production/${mProductionId}`,
        method: 'PUT',
        token: lirionToken,
        body: {
            'doc-action': 'CO'
        }
    });
}


function esErrorPeriodoCerradoLirion(err) {
    const texto = String(
        err?.message ||
        err?.responseBody?.error ||
        err?.responseBody?.detail ||
        err?.responseBody?.message ||
        err?.responseBody?.raw ||
        ''
    ).toLowerCase();

    return texto.includes('periodo cerrado') || texto.includes('period closed');
}

async function reintentarCompletarProduccionCorrigiendoFechaSiPeriodoCerrado({
    mProductionId,
    lirionToken,
    plannerId,
    op
}) {
    try {
        return await procesarProduccionEnLirionConUsuario(mProductionId, lirionToken);
    } catch (err) {
        if (!esErrorPeriodoCerradoLirion(err)) {
            throw err;
        }

        // Lirion valida el periodo usando la MovementDate de M_Production.
        // Si la OP quedó en borrador con una fecha de un periodo ya cerrado,
        // no se debe forzar el DocStatus por BD. Solo se actualiza la fecha del
        // documento borrador a la fecha actual y se vuelve a ejecutar la acción
        // real de Lirion (DocAction=CO), para que el ERP complete el documento.
        console.warn(`⚠️ OP ${op}: Lirion rechazó completar por periodo cerrado. Se actualiza MovementDate a CURRENT_DATE y se reintenta DocAction=CO.`);

        await poolIdempiere.query(`
            UPDATE adempiere.m_production
            SET movementdate = CURRENT_DATE,
                datepromised = COALESCE(datepromised, CURRENT_DATE),
                updated = NOW(),
                updatedby = $1
            WHERE m_production_id = $2
              AND docstatus = 'DR'
              AND processed = 'N'
        `, [plannerId, mProductionId]);

        return await procesarProduccionEnLirionConUsuario(mProductionId, lirionToken);
    }
}

async function verificarProduccionProcesada(mProductionId) {
    const result = await poolIdempiere.query(`
        SELECT 
            m_production_id,
            documentno,
            docstatus,
            processed,
            posted,
            processing
        FROM adempiere.m_production
        WHERE m_production_id = $1
        LIMIT 1
    `, [mProductionId]);

    if (!result.rows.length) {
        throw new Error(`No se encontró M_Production_ID ${mProductionId} después de procesar.`);
    }

    const prod = result.rows[0];

    return {
        ...prod,
        completada: prod.docstatus === 'CO' && prod.processed === 'Y'
    };
}

async function validarStockRutaAntesDeCrear(client, ruta) {
    const problemas = [];

    for (const etapa of ruta || []) {
        for (const mat of (etapa.materiales || [])) {
            const productId = Number(mat.m_product_id);
            const locatorId = Number(mat.m_locator_id);
            const asiId = mat.m_attributesetinstance_id === null || mat.m_attributesetinstance_id === undefined || mat.m_attributesetinstance_id === ''
                ? null
                : Number(mat.m_attributesetinstance_id);
            const cantidad = Number(mat.cantidad || 0);

            if (!productId || cantidad <= 0) continue;

            if (!locatorId || asiId === null || Number.isNaN(asiId)) {
                problemas.push({
                    material: mat.nombre_visual || productId,
                    problema: 'SIN_UBICACION_O_LOTE',
                    solicitado: cantidad,
                    disponible: null
                });
                continue;
            }

            const stock = await client.query(`
                SELECT COALESCE(SUM(qtyonhand), 0) AS disponible
                FROM adempiere.m_storageonhand
                WHERE m_product_id = $1
                  AND m_locator_id = $2
                  AND m_attributesetinstance_id = $3
            `, [productId, locatorId, asiId]);

            const disponible = Number(stock.rows[0].disponible || 0);

            if (disponible < cantidad) {
                problemas.push({
                    material: mat.nombre_visual || productId,
                    m_product_id: productId,
                    m_locator_id: locatorId,
                    m_attributesetinstance_id: asiId,
                    solicitado: cantidad,
                    disponible
                });
            }
        }
    }

    if (problemas.length > 0) {
        const detalle = problemas.map(p =>
            `${p.material} solicitado=${p.solicitado}, disponible=${p.disponible ?? 'N/A'}`
        ).join(' | ');

        throw new Error(`Stock insuficiente o ubicación/lote inválido: ${detalle}`);
    }
}

function normalizarValueEtapa(nombre) {
    return String(nombre || 'ETAPA')
        .trim()
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 40) || 'ETAPA';
}


function parseJsonArraySeguro(valor, fallback = []) {
    if (Array.isArray(valor)) return valor;
    if (valor === null || valor === undefined || valor === '') return fallback;
    try {
        const parsed = typeof valor === 'string' ? JSON.parse(valor) : valor;
        return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function numeroSeguro(valor, fallback = 0) {
    if (valor === null || valor === undefined || valor === '') return fallback;
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : fallback;
    let limpio = String(valor).trim();
    if (limpio.includes(',') && limpio.includes('.')) {
        limpio = limpio.replace(/\./g, '').replace(',', '.');
    } else if (limpio.includes(',')) {
        limpio = limpio.replace(',', '.');
    }
    const n = Number(limpio);
    return Number.isFinite(n) ? n : fallback;
}


function calcularProduccionFinalNoSumada(datosProcesos = [], fallback = 0) {
    const procesos = Array.isArray(datosProcesos) ? datosProcesos : [];

    const conCantidad = procesos
        .map((p, index) => ({
            ...p,
            __orden: index,
            __cantidad: numeroSeguro(p?.cantidad_contada, 0),
            __id: Number(p?.id || 0)
        }))
        .filter(p => p.__cantidad > 0);

    if (conCantidad.length === 0) {
        return numeroSeguro(fallback, 0);
    }

    conCantidad.sort((a, b) => {
        if (a.__id !== b.__id) return a.__id - b.__id;
        return a.__orden - b.__orden;
    });

    return numeroSeguro(conCantidad[conCantidad.length - 1].__cantidad, 0);
}

async function obtenerProduccionFinalOpPMS(op) {
    const realOp = await db.get(`
        SELECT cantidad_contada
        FROM procesos
        WHERE op = ?
          AND estado = 'FINALIZADO'
          AND cantidad_contada IS NOT NULL
        ORDER BY fecha_salida DESC, id DESC
        LIMIT 1
    `, [op]);

    return numeroSeguro(realOp?.cantidad_contada, 0);
}

async function actualizarLineasProduccionPorOperadorEnLirion(client, { op, etapa, materiales, updatedBy }) {
    const operadorId = Number(updatedBy);

    if (!Number.isFinite(operadorId) || operadorId <= 0 || operadorId === 100) {
        throw new Error('No se pudo determinar el AD_User_ID real del operador en Lirion. Cierre sesión e ingrese nuevamente.');
    }

    const mats = parseJsonArraySeguro(materiales, []).filter(mat =>
        Number(mat?.m_product_id) > 0 && numeroSeguro(mat?.cantidad_real ?? mat?.cantidad) > 0
    );

    if (mats.length === 0) return { actualizadas: 0, detalle: [] };

    const prod = await client.query(`
        SELECT m_production_id, documentno, docstatus, processed
        FROM adempiere.m_production
        WHERE regexp_replace(UPPER(TRIM(documentno)), '[^A-Z0-9]', '', 'g') =
              regexp_replace(UPPER(TRIM($1)), '[^A-Z0-9]', '', 'g')
          AND isactive = 'Y'
        ORDER BY created DESC
        LIMIT 1
    `, [op]);

    if (!prod.rows.length) {
        throw new Error(`No se encontró la OP ${op} en Lirion para asignar lotes.`);
    }

    const production = prod.rows[0];

    if (String(production.processed || 'N').toUpperCase() === 'Y' || String(production.docstatus || '').toUpperCase() === 'CO') {
        throw new Error(`La OP ${op} ya está procesada/completada en Lirion. No se pueden modificar lotes ni cantidades.`);
    }

    const productionId = Number(production.m_production_id);
    const detalle = [];

    for (const mat of mats) {
        const productId = Number(mat.m_product_id);
        const cantidadReal = numeroSeguro(mat.cantidad_real ?? mat.cantidad);
        const locatorId = Number(mat.m_locator_id);
        const asiId = mat.m_attributesetinstance_id === null || mat.m_attributesetinstance_id === undefined || mat.m_attributesetinstance_id === ''
            ? null
            : Number(mat.m_attributesetinstance_id);
        const nombreMaterial = mat.nombre_visual || mat.nombre || productId;
        const etapaMaterial = String(mat.etapa_nombre || etapa || '').trim();

        if (!locatorId || asiId === null || Number.isNaN(asiId)) {
            throw new Error(`Debe seleccionar ubicación y lote para el insumo ${nombreMaterial}.`);
        }

        const stock = await client.query(`
            SELECT COALESCE(SUM(qtyonhand), 0) AS disponible
            FROM adempiere.m_storageonhand
            WHERE m_product_id = $1
              AND m_locator_id = $2
              AND m_attributesetinstance_id = $3
        `, [productId, locatorId, asiId]);

        const disponible = Number(stock.rows[0]?.disponible || 0);
        if (disponible < cantidadReal) {
            throw new Error(`${nombreMaterial}: stock insuficiente para el lote seleccionado. Solicitado=${cantidadReal}, disponible=${disponible}.`);
        }

        const patronEtapa = etapaMaterial ? `%${etapaMaterial}%` : '%%';
        const line = await client.query(`
            SELECT m_productionline_id, line, description
            FROM adempiere.m_productionline
            WHERE m_production_id = $1
              AND m_product_id = $2
              AND isactive = 'Y'
              AND COALESCE(isendproduct, 'N') = 'N'
            ORDER BY
              CASE WHEN COALESCE(description, '') ILIKE $3 THEN 0 ELSE 1 END,
              line ASC,
              m_productionline_id ASC
            LIMIT 1
        `, [productionId, productId, patronEtapa]);

        const qtyConsumo = cantidadReal * -1;
        const loteTexto = mat.lote_nombre ? ` | Lote: ${mat.lote_nombre}` : '';
        const ubicacionTexto = mat.bodega || mat.almacen ? ` | Ubicación: ${mat.bodega || mat.almacen}` : '';
        const descripcion = `PMS Operador ${etapaMaterial || 'Etapa'}${ubicacionTexto}${loteTexto}`.substring(0, 255);

        let lineId = line.rows.length ? Number(line.rows[0].m_productionline_id) : null;
        let accionLinea = 'actualizada';

        if (lineId) {
            await client.query(`
                UPDATE adempiere.m_productionline
                SET m_locator_id = $1,
                    m_attributesetinstance_id = $2,
                    movementqty = $3,
                    plannedqty = $3,
                    description = $4,
                    updated = NOW(),
                    updatedby = $5
                WHERE m_productionline_id = $6
            `, [locatorId, asiId, qtyConsumo, descripcion, operadorId, lineId]);
        } else {
            // Si planificación dejó el insumo con cantidad 0, la línea no fue creada en M_ProductionLine.
            // En ese caso, si el operador declara consumo real, insertamos la línea faltante en la OP borrador.
            const nextLineId = await client.query(`
                SELECT COALESCE(MAX(m_productionline_id), 0) + 1 AS next_id
                FROM adempiere.m_productionline
            `);

            const nextLineNo = await client.query(`
                SELECT COALESCE(MAX(line), 10) + 10 AS next_line
                FROM adempiere.m_productionline
                WHERE m_production_id = $1
            `, [productionId]);

            lineId = Number(nextLineId.rows[0].next_id);
            const lineNo = Number(nextLineNo.rows[0].next_line || 20);
            const descripcionNueva = `${descripcion} | Línea agregada por PMS porque Planificación la dejó en 0`.substring(0, 255);

            await client.query(`
                INSERT INTO adempiere.m_productionline (
                    m_productionline_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
                    m_production_id, line, m_product_id, m_locator_id, movementqty, plannedqty,
                    isendproduct, m_attributesetinstance_id, description, m_productionline_uu, processed
                ) VALUES (
                    $1, 1000000, 1000000, 'Y', NOW(), $2, NOW(), $2,
                    $3, $4, $5, $6, $7, $7,
                    'N', $8, $9, $10, 'N'
                )
            `, [
                lineId,
                operadorId,
                productionId,
                lineNo,
                productId,
                locatorId,
                qtyConsumo,
                asiId,
                descripcionNueva,
                uuidv4()
            ]);

            accionLinea = 'insertada';
        }

        detalle.push({
            accion: accionLinea,
            m_productionline_id: lineId,
            m_product_id: productId,
            cantidad_real: cantidadReal,
            m_locator_id: locatorId,
            m_attributesetinstance_id: asiId
        });
    }

    await client.query(`
        UPDATE adempiere.m_production
        SET updated = NOW(), updatedby = $1
        WHERE m_production_id = $2
    `, [operadorId, productionId]);

    return { actualizadas: detalle.length, detalle };
}




async function construirNombreWorkflowUnico(client, productoNombre, productoCodigo, op) {
    const limpiar = (valor) => String(valor || '')
        .trim()
        .replace(/\s+/g, ' ');

    const baseOriginal = limpiar(productoNombre || productoCodigo || 'RECETA PMS');
    const opSafe = limpiar(op || Date.now()).replace(/[^A-Za-z0-9_-]/g, '').substring(0, 18) || String(Date.now());

    // AD_Workflow.name tiene restricción única. No basta con desactivar el workflow anterior.
    // Por eso usamos nombre único por OP, manteniendo AD_Workflow.value = producto_codigo.
    let base = baseOriginal.substring(0, 42);
    let nombre = `${base} OP ${opSafe}`.substring(0, 60);
    let contador = 1;

    while (true) {
        const existe = await client.query(`
            SELECT 1
            FROM adempiere.ad_workflow
            WHERE ad_client_id = 1000000
              AND UPPER(TRIM(name)) = UPPER(TRIM($1))
            LIMIT 1
        `, [nombre]);

        if (existe.rows.length === 0) {
            return nombre;
        }

        contador++;
        const sufijo = ` ${contador}`;
        const maxBaseLength = Math.max(10, 60 - (` OP ${opSafe}${sufijo}`).length);
        base = baseOriginal.substring(0, maxBaseLength);
        nombre = `${base} OP ${opSafe}${sufijo}`.substring(0, 60);
    }
}

// ==========================================
// RUTAS LIRION (INCLUYE INGENIERÍA INVERSA RECETA)
// ==========================================

app.get('/api/idempiere/materias-primas', async (req, res) => {
    try {
        const result = await poolIdempiere.query(`SELECT value as codigo, name as nombre FROM M_Product WHERE isactive = 'Y' AND value IS NOT NULL ORDER BY value ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/idempiere/pedidos', async (req, res) => {
    try {
        const { pedido, cliente, producto, fecha_desde, fecha_hasta } = req.query;

        let conditions = [`o.isactive = 'Y'`, `o.issotrx = 'Y'`, `o.docstatus = 'CO'`, `o.c_doctypetarget_id = 1000493`];
        let params = [];
        let paramIndex = 1;

        if (pedido && pedido.trim()) {
            conditions.push(`UPPER(o.documentno) LIKE $${paramIndex}`);
            params.push(`%${pedido.trim().toUpperCase()}%`);
            paramIndex++;
        }

        if (cliente && cliente.trim()) {
            conditions.push(`UPPER(bp.name) LIKE $${paramIndex}`);
            params.push(`%${cliente.trim().toUpperCase()}%`);
            paramIndex++;
        }

        if (producto && producto.trim()) {
            conditions.push(`(UPPER(p.value) LIKE $${paramIndex} OR UPPER(p.name) LIKE $${paramIndex})`);
            params.push(`%${producto.trim().toUpperCase()}%`);
            paramIndex++;
        }

        if (fecha_desde && fecha_desde.trim()) {
            conditions.push(`o.datepromised::date >= $${paramIndex}::date`);
            params.push(fecha_desde.trim());
            paramIndex++;
        }

        if (fecha_hasta && fecha_hasta.trim()) {
            conditions.push(`o.datepromised::date <= $${paramIndex}::date`);
            params.push(fecha_hasta.trim());
            paramIndex++;
        }

        let query = `
            SELECT 
                o.documentno AS numero, 
                o.description AS detalle,
                bp.name AS cliente,
                o.datepromised AS fecha_prometida,
                STRING_AGG(DISTINCT (p.value || ' - ' || p.name), ', ') AS productos
            FROM C_Order o
            LEFT JOIN C_BPartner bp ON o.c_bpartner_id = bp.c_bpartner_id
            LEFT JOIN C_OrderLine ol ON o.c_order_id = ol.c_order_id AND ol.isactive = 'Y'
            LEFT JOIN M_Product p ON ol.m_product_id = p.m_product_id
            WHERE ${conditions.join(' AND ')}
            GROUP BY o.c_order_id, o.documentno, o.description, bp.name, o.datepromised
            ORDER BY o.documentno DESC
        `;

        const result = await poolIdempiere.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// =======================================================
// CONTROL DE CANTIDADES PEDIDO ↔ OP PMS
// =======================================================
function normalizarCodigoProducto(valor) {
    return String(valor || '').trim().toUpperCase();
}

function esEstadoPlanificacionContabilizable(estado) {
    const e = String(estado || '').trim().toUpperCase();

    // Estados rechazados/anulados no deben bloquear una nueva OP para el mismo pedido.
    return ![
        'RECHAZADO',
        'RECHAZADA',
        'ANULADO',
        'ANULADA',
        'CANCELADO',
        'CANCELADA'
    ].includes(e);
}

async function obtenerCantidadesPedidoPMS(numeroPedido) {
    const detallePedido = await poolIdempiere.query(`
        SELECT
            o.dateordered,
            o.datepromised,
            bp.name AS cliente,
            p.value AS prod_codigo,
            p.name AS prod_nombre,
            SUM(COALESCE(ol.qtyentered, 0)) AS cantidad,
            MAX(uom.name) AS um,
            STRING_AGG(NULLIF(ol.description, ''), ' | ') AS linea_desc
        FROM C_Order o
        JOIN C_OrderLine ol ON o.c_order_id = ol.c_order_id
        JOIN C_BPartner bp ON o.c_bpartner_id = bp.c_bpartner_id
        JOIN M_Product p ON ol.m_product_id = p.m_product_id
        JOIN C_UOM uom ON ol.c_uom_id = uom.c_uom_id
        WHERE o.documentno = $1
          AND o.issotrx = 'Y'
          AND o.c_doctypetarget_id = 1000493
          AND o.docstatus = 'CO'
          AND o.isactive = 'Y'
          AND ol.isactive = 'Y'
        GROUP BY o.dateordered, o.datepromised, bp.name, p.value, p.name
        ORDER BY p.value ASC, p.name ASC
    `, [numeroPedido]);

    if (!detallePedido.rows.length) {
        return null;
    }

    const opsLocales = await db.all(`
        SELECT
            op,
            producto_codigo,
            producto_nombre,
            cantidad_planificada,
            estado
        FROM ordenes_planificacion
        WHERE numero_pedido = ?
        ORDER BY fecha_creacion ASC, id ASC
    `, [numeroPedido]);

    const resumenPorCodigo = new Map();

    for (const linea of detallePedido.rows) {
        const codigo = normalizarCodigoProducto(linea.prod_codigo);
        const solicitado = numeroSeguro(linea.cantidad, 0);

        resumenPorCodigo.set(codigo, {
            codigo,
            nombre: linea.prod_nombre,
            um: linea.um,
            cantidad_pedido: solicitado,
            cantidad_planificada_pms: 0,
            cantidad_real_producida: 0,
            cantidad_disponible_planificar: solicitado,
            estado_cantidad: 'PENDIENTE',
            ops: []
        });
    }

    for (const opLocal of (opsLocales || [])) {
        if (!esEstadoPlanificacionContabilizable(opLocal.estado)) continue;

        const codigo = normalizarCodigoProducto(opLocal.producto_codigo);
        if (!resumenPorCodigo.has(codigo)) continue;

        const resumen = resumenPorCodigo.get(codigo);
        const cantidadPlanificada = numeroSeguro(opLocal.cantidad_planificada, 0);

        // Para no sobrecontar etapas, tomamos la última cantidad finalizada registrada por OP.
        const realOp = await db.get(`
            SELECT cantidad_contada
            FROM procesos
            WHERE op = ?
              AND estado = 'FINALIZADO'
              AND cantidad_contada IS NOT NULL
            ORDER BY fecha_salida DESC, id DESC
            LIMIT 1
        `, [opLocal.op]);

        const cantidadReal = numeroSeguro(realOp?.cantidad_contada, 0);

        resumen.cantidad_planificada_pms += cantidadPlanificada;
        resumen.cantidad_real_producida += cantidadReal;
        resumen.ops.push({
            op: opLocal.op,
            estado: opLocal.estado,
            cantidad_planificada: cantidadPlanificada,
            cantidad_real_producida: cantidadReal
        });
    }

    for (const resumen of resumenPorCodigo.values()) {
        resumen.cantidad_disponible_planificar = Math.max(
            resumen.cantidad_pedido - resumen.cantidad_planificada_pms,
            0
        );

        if (resumen.cantidad_disponible_planificar <= 0) {
            resumen.estado_cantidad = 'COMPLETO';
        } else if (resumen.cantidad_planificada_pms > 0 || resumen.cantidad_real_producida > 0) {
            resumen.estado_cantidad = 'PARCIAL';
        } else {
            resumen.estado_cantidad = 'PENDIENTE';
        }
    }

    const lineas = detallePedido.rows.map(r => {
        const resumen = resumenPorCodigo.get(normalizarCodigoProducto(r.prod_codigo));
        const disponible = resumen?.cantidad_disponible_planificar ?? numeroSeguro(r.cantidad, 0);

        return {
            codigo: r.prod_codigo,
            nombre: r.prod_nombre,
            cantidad: disponible,
            cantidad_pedido: resumen?.cantidad_pedido ?? numeroSeguro(r.cantidad, 0),
            cantidad_original: resumen?.cantidad_pedido ?? numeroSeguro(r.cantidad, 0),
            cantidad_planificada_pms: resumen?.cantidad_planificada_pms ?? 0,
            cantidad_real_producida: resumen?.cantidad_real_producida ?? 0,
            cantidad_disponible_planificar: disponible,
            estado_cantidad: resumen?.estado_cantidad || 'PENDIENTE',
            ops_pms: resumen?.ops || [],
            um: r.um,
            descripcion: r.linea_desc
        };
    });

    const totalPedido = lineas.reduce((acc, l) => acc + numeroSeguro(l.cantidad_pedido, 0), 0);
    const totalPlanificado = lineas.reduce((acc, l) => acc + numeroSeguro(l.cantidad_planificada_pms, 0), 0);
    const totalReal = lineas.reduce((acc, l) => acc + numeroSeguro(l.cantidad_real_producida, 0), 0);
    const totalDisponible = lineas.reduce((acc, l) => acc + numeroSeguro(l.cantidad_disponible_planificar, 0), 0);

    return {
        cabecera: {
            numero: numeroPedido,
            fecha_orden: detallePedido.rows[0].dateordered,
            fecha_prometida: detallePedido.rows[0].datepromised,
            cliente: detallePedido.rows[0].cliente,
            total_pedido: totalPedido,
            total_planificado_pms: totalPlanificado,
            total_real_producido: totalReal,
            total_disponible_planificar: totalDisponible,
            pedido_completo_pms: totalPedido > 0 && totalDisponible <= 0
        },
        lineas
    };
}

async function validarCantidadDisponiblePedido({ numero_pedido, producto_codigo, cantidad_planificada, op_excluir = null }) {
    if (!numero_pedido) return;

    const resumen = await obtenerCantidadesPedidoPMS(numero_pedido);
    if (!resumen) {
        throw new Error(`No se encontró el pedido ${numero_pedido} en Lirion.`);
    }

    const codigo = normalizarCodigoProducto(producto_codigo);
    const linea = (resumen.lineas || []).find(l => normalizarCodigoProducto(l.codigo) === codigo);

    if (!linea) {
        throw new Error(`El producto ${producto_codigo} no pertenece al pedido ${numero_pedido}.`);
    }

    let disponible = numeroSeguro(linea.cantidad_disponible_planificar, 0);

    // Si se está actualizando/rehaciendo una OP específica, se puede excluir del saldo.
    // En el flujo actual de nueva OP normalmente queda en null.
    if (op_excluir) {
        const opActual = await db.get(`
            SELECT cantidad_planificada, estado
            FROM ordenes_planificacion
            WHERE numero_pedido = ? AND producto_codigo = ? AND op = ?
            LIMIT 1
        `, [numero_pedido, producto_codigo, op_excluir]);

        if (opActual && esEstadoPlanificacionContabilizable(opActual.estado)) {
            disponible += numeroSeguro(opActual.cantidad_planificada, 0);
        }
    }

    const cantidadNueva = numeroSeguro(cantidad_planificada, 0);

    if (cantidadNueva <= 0) {
        throw new Error(`Debe ingresar una cantidad mayor a 0 para ${producto_codigo}.`);
    }

    if (cantidadNueva > disponible) {
        throw new Error(
            `Oye, el pedido ${numero_pedido} solicita ${linea.cantidad_pedido} unidades de ${producto_codigo}. ` +
            `Ya hay ${linea.cantidad_planificada_pms} planificadas y solo quedan ${disponible}. ` +
            `No necesitas producir ${cantidadNueva}.`
        );
    }
}

app.get('/api/idempiere/pedido-detalle/:documentno', async (req, res) => {
    const { documentno } = req.params;
    try {
        const resumen = await obtenerCantidadesPedidoPMS(documentno);

        if (!resumen) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        res.json(resumen);
    } catch (err) {
        console.error('❌ Error cargando detalle/control de cantidades del pedido:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/planificacion/validar-cantidades-pedido', async (req, res) => {
    const { numero_pedido, lineas } = req.body || {};

    try {
        if (!numero_pedido) {
            return res.status(400).json({ error: 'Debe indicar el número de pedido.' });
        }

        const lineasValidar = parseJsonArraySeguro(lineas, []);
        if (lineasValidar.length === 0) {
            return res.status(400).json({ error: 'Debe enviar al menos una línea para validar.' });
        }

        // Agrupa por producto para evitar que dos líneas del mismo código se salten el saldo.
        const acumulado = new Map();
        for (const linea of lineasValidar) {
            const codigo = normalizarCodigoProducto(linea.producto_codigo || linea.codigo);
            const cantidad = numeroSeguro(linea.cantidad_planificada ?? linea.cantidad, 0);
            if (!codigo) continue;
            acumulado.set(codigo, (acumulado.get(codigo) || 0) + cantidad);
        }

        for (const [codigo, cantidad] of acumulado.entries()) {
            await validarCantidadDisponiblePedido({
                numero_pedido,
                producto_codigo: codigo,
                cantidad_planificada: cantidad
            });
        }

        res.json({ success: true, message: 'Cantidades del pedido validadas correctamente.' });
    } catch (err) {
        console.error('❌ Error validando cantidades del pedido:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// 🔥 INGENIERÍA INVERSA DE RECETA (WORKFLOW + M_PRODUCTION)

// =======================================================
// AUXILIAR: OBTENER RECETA HISTÓRICA DESDE M_PRODUCTION
// =======================================================
async function obtenerRecetaHistoricaProducto(m_product_id) {
    const lastProd = await poolIdempiere.query(`
        SELECT mp.m_production_id, mp.productionqty
        FROM adempiere.m_production mp
        WHERE mp.m_product_id = $1
          AND mp.isactive = 'Y'
          AND COALESCE(mp.productionqty, 0) > 0
          AND EXISTS (
              SELECT 1
              FROM adempiere.m_productionline pl
              WHERE pl.m_production_id = mp.m_production_id
                AND pl.isactive = 'Y'
                AND COALESCE(pl.isendproduct, 'N') = 'N'
                AND COALESCE(pl.movementqty, 0) <> 0
          )
        ORDER BY mp.processed DESC, mp.created DESC
        LIMIT 1
    `, [m_product_id]);

    if (!lastProd.rows.length) {
        return { tieneReceta: false, baseQty: 1, productionId: null, lineas: [] };
    }

    const productionId = lastProd.rows[0].m_production_id;
    const baseQty = Math.abs(parseFloat(lastProd.rows[0].productionqty)) || 1;

    const lines = await poolIdempiere.query(`
        SELECT 
            pl.m_product_id,
            pl.movementqty,
            pl.m_locator_id,
            pl.m_attributesetinstance_id,
            p.value AS codigo,
            p.name AS nombre,
            u.name AS uom_nombre,
            u.c_uom_id
        FROM adempiere.m_productionline pl
        JOIN adempiere.m_product p ON p.m_product_id = pl.m_product_id
        LEFT JOIN adempiere.c_uom u ON u.c_uom_id = p.c_uom_id
        WHERE pl.m_production_id = $1
          AND pl.isactive = 'Y'
          AND COALESCE(pl.isendproduct, 'N') = 'N'
          AND COALESCE(pl.movementqty, 0) <> 0
        ORDER BY pl.line ASC, pl.m_productionline_id ASC
    `, [productionId]);

    return { tieneReceta: true, baseQty, productionId, lineas: lines.rows };
}

// =======================================================
// INGENIERÍA INVERSA RECETA / FLUJO DE TRABAJO LIRION
// =======================================================
app.get('/api/idempiere/receta/:producto_codigo', async (req, res) => {
    const { producto_codigo } = req.params;

    try {
        const prod = await poolIdempiere.query(`
            SELECT m_product_id, value, name, c_uom_id
            FROM adempiere.m_product
            WHERE value = $1 AND isactive = 'Y'
            LIMIT 1
        `, [producto_codigo]);

        if (!prod.rows.length) {
            return res.json({
                existe: false,
                tiene_flujo: false,
                tiene_receta: false,
                estado_receta: 'sin_producto',
                mensaje: 'Producto no encontrado en Lirion.',
                ruta: []
            });
        }

        const m_product_id = prod.rows[0].m_product_id;
        const recetaHistorica = await obtenerRecetaHistoricaProducto(m_product_id);

        const wf = await poolIdempiere.query(`
            SELECT ad_workflow_id, ad_wf_node_id, name, value
            FROM adempiere.ad_workflow
            WHERE value = $1 AND isactive = 'Y'
            ORDER BY updated DESC, created DESC
            LIMIT 1
        `, [producto_codigo]);

        const construirMaterialesDesdeReceta = () => recetaHistorica.lineas.map(l => {
            const rawQty = parseFloat(l.movementqty) || 0;
            const ratio = Math.abs(rawQty) / recetaHistorica.baseQty;

            return {
                m_product_id: l.m_product_id,
                nombre_visual: `[${l.codigo}] ${l.nombre}`,
                codigo: l.codigo,
                nombre: l.nombre,
                cantidad_base: ratio,
                cantidad: 0,
                uom_nombre: l.uom_nombre,
                c_uom_id: l.c_uom_id,
                m_locator_id: null,
                m_attributesetinstance_id: null,
                opciones_stock: []
            };
        });

        const etapaGeneral = (mensaje, ad_workflow_id = null) => res.json({
            existe: true,
            tiene_flujo: false,
            tiene_receta: true,
            estado_receta: 'solo_receta',
            mensaje,
            ad_workflow_id,
            m_product_id,
            m_production_id_base: recetaHistorica.productionId,
            productionqty_base: recetaHistorica.baseQty,
            ruta: [{
                ad_wf_node_id: null,
                nombre_etapa: 'Etapa General',
                area: 'Etapa General',
                value_etapa: 'ETAPA_GENERAL',
                orden_flujo: 1,
                conectado_por_transicion: 'N',
                maquina_id: null,
                maquina_nombre: null,
                responsable_id: null,
                materiales: construirMaterialesDesdeReceta()
            }]
        });

        if (!wf.rows.length) {
            if (recetaHistorica.tieneReceta) {
                return etapaGeneral('Se encontró receta histórica en Lirion, pero no existe flujo de trabajo.');
            }

            return res.json({
                existe: false,
                tiene_flujo: false,
                tiene_receta: false,
                estado_receta: 'sin_flujo_sin_receta',
                mensaje: 'No se encontró flujo de trabajo ni receta histórica para este producto.',
                ad_workflow_id: null,
                m_product_id,
                ruta: []
            });
        }

        const ad_workflow_id = wf.rows[0].ad_workflow_id;
        const nodoInicialId = wf.rows[0].ad_wf_node_id;

        const nodesResult = await poolIdempiere.query(`
            WITH RECURSIVE chain AS (
                SELECT
                    n.ad_wf_node_id,
                    1::integer AS orden_flujo,
                    ARRAY[n.ad_wf_node_id]::numeric[] AS path
                FROM adempiere.ad_wf_node n
                WHERE n.ad_workflow_id = $1
                  AND n.isactive = 'Y'
                  AND n.ad_wf_node_id = COALESCE(
                        $2::numeric,
                        (
                            SELECT n0.ad_wf_node_id
                            FROM adempiere.ad_wf_node n0
                            WHERE n0.ad_workflow_id = $1
                              AND n0.isactive = 'Y'
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM adempiere.ad_wf_nodenext prev
                                  WHERE prev.ad_wf_next_id = n0.ad_wf_node_id
                                    AND prev.isactive = 'Y'
                              )
                            ORDER BY n0.xposition ASC, n0.ad_wf_node_id ASC
                            LIMIT 1
                        ),
                        (
                            SELECT MIN(n1.ad_wf_node_id)
                            FROM adempiere.ad_wf_node n1
                            WHERE n1.ad_workflow_id = $1
                              AND n1.isactive = 'Y'
                        )
                  )

                UNION ALL

                SELECT
                    nnext.ad_wf_node_id,
                    c.orden_flujo + 1 AS orden_flujo,
                    c.path || nnext.ad_wf_node_id
                FROM chain c
                JOIN LATERAL (
                    SELECT nx.ad_wf_next_id
                    FROM adempiere.ad_wf_nodenext nx
                    WHERE nx.ad_wf_node_id = c.ad_wf_node_id
                      AND nx.isactive = 'Y'
                    ORDER BY nx.seqno ASC, nx.ad_wf_nodenext_id ASC
                    LIMIT 1
                ) siguiente ON true
                JOIN adempiere.ad_wf_node nnext
                  ON nnext.ad_wf_node_id = siguiente.ad_wf_next_id
                 AND nnext.ad_workflow_id = $1
                 AND nnext.isactive = 'Y'
                WHERE NOT (nnext.ad_wf_node_id = ANY(c.path))
            ),
            ordenados AS (
                SELECT
                    n.ad_wf_node_id,
                    n.name,
                    n.value,
                    n.ad_wf_responsible_id,
                    n.xposition,
                    c.orden_flujo,
                    'Y'::text AS conectado_por_transicion
                FROM chain c
                JOIN adempiere.ad_wf_node n ON n.ad_wf_node_id = c.ad_wf_node_id
            ),
            sueltos AS (
                SELECT
                    n.ad_wf_node_id,
                    n.name,
                    n.value,
                    n.ad_wf_responsible_id,
                    n.xposition,
                    (100000 + ROW_NUMBER() OVER (ORDER BY n.xposition ASC, n.ad_wf_node_id ASC))::integer AS orden_flujo,
                    'N'::text AS conectado_por_transicion
                FROM adempiere.ad_wf_node n
                WHERE n.ad_workflow_id = $1
                  AND n.isactive = 'Y'
                  AND NOT EXISTS (SELECT 1 FROM chain c WHERE c.ad_wf_node_id = n.ad_wf_node_id)
            )
            SELECT * FROM ordenados
            UNION ALL
            SELECT * FROM sueltos
            ORDER BY orden_flujo ASC
        `, [ad_workflow_id, nodoInicialId || null]);

        if (!nodesResult.rows.length) {
            if (recetaHistorica.tieneReceta) {
                return etapaGeneral('Existe workflow, pero no tiene nodos. Se cargó receta histórica en una etapa general.', ad_workflow_id);
            }

            return res.json({
                existe: false,
                tiene_flujo: false,
                tiene_receta: false,
                estado_receta: 'sin_nodos',
                mensaje: 'El flujo existe, pero no tiene etapas activas.',
                ad_workflow_id,
                m_product_id,
                ruta: []
            });
        }

        const nodes = nodesResult.rows;
        const nodeIds = nodes.map(n => n.ad_wf_node_id);

        const nodeAssets = await poolIdempiere.query(`
            SELECT pwa.ad_wf_node_id, pwa.a_asset_id, aa.name AS asset_name, aa.value AS asset_value
            FROM adempiere.pp_wf_node_asset pwa
            JOIN adempiere.a_asset aa ON aa.a_asset_id = pwa.a_asset_id
            WHERE pwa.ad_wf_node_id = ANY($1)
              AND pwa.isactive = 'Y'
              AND aa.isactive = 'Y'
            ORDER BY pwa.seqno ASC, pwa.pp_wf_node_asset_id ASC
        `, [nodeIds]);

        const nodeProducts = await poolIdempiere.query(`
            SELECT 
                wp.ad_wf_node_id,
                wp.m_product_id,
                p.value AS codigo,
                p.name AS nombre,
                u.name AS uom_nombre,
                u.c_uom_id
            FROM adempiere.pp_wf_node_product wp
            JOIN adempiere.m_product p ON wp.m_product_id = p.m_product_id
            LEFT JOIN adempiere.c_uom u ON p.c_uom_id = u.c_uom_id
            WHERE wp.ad_wf_node_id = ANY($1)
              AND wp.isactive = 'Y'
            ORDER BY wp.ad_wf_node_id, wp.seqno ASC, wp.pp_wf_node_product_id ASC
        `, [nodeIds]);

        const tieneReceta = recetaHistorica.tieneReceta;
        const productionLines = recetaHistorica.lineas;
        const baseQty = recetaHistorica.baseQty;

        const ruta = nodes.map(n => {
            const asset = nodeAssets.rows.find(a => String(a.ad_wf_node_id) === String(n.ad_wf_node_id));
            const mats = nodeProducts.rows.filter(mp => String(mp.ad_wf_node_id) === String(n.ad_wf_node_id));

            const materiales = mats.map(m => {
                const pLine = productionLines.find(pl => String(pl.m_product_id) === String(m.m_product_id));
                const rawQty = pLine ? parseFloat(pLine.movementqty) : 0;
                const ratio = tieneReceta ? Math.abs(rawQty) / baseQty : 0;

                return {
                    m_product_id: m.m_product_id,
                    nombre_visual: `[${m.codigo}] ${m.nombre}`,
                    codigo: m.codigo,
                    nombre: m.nombre,
                    cantidad_base: ratio,
                    cantidad: 0,
                    uom_nombre: m.uom_nombre,
                    c_uom_id: m.c_uom_id,
                    m_locator_id: null,
                    m_attributesetinstance_id: null,
                    opciones_stock: []
                };
            });

            return {
                ad_wf_node_id: n.ad_wf_node_id,
                nombre_etapa: n.name,
                area: n.name,
                value_etapa: n.value,
                orden_flujo: n.orden_flujo,
                conectado_por_transicion: n.conectado_por_transicion,
                maquina_id: asset ? asset.a_asset_id : null,
                maquina_nombre: asset ? asset.asset_name : null,
                responsable_id: n.ad_wf_responsible_id,
                materiales
            };
        });

        return res.json({
            existe: true,
            tiene_flujo: true,
            tiene_receta: tieneReceta,
            estado_receta: tieneReceta ? 'flujo_y_receta' : 'solo_flujo',
            mensaje: tieneReceta
                ? 'Se encontró flujo de trabajo y receta histórica. Las cantidades serán calculadas automáticamente.'
                : 'Se encontró flujo de trabajo, pero no receta histórica. Las cantidades quedan en cero.',
            ad_workflow_id,
            m_product_id,
            nodo_inicial_id: nodoInicialId,
            m_production_id_base: recetaHistorica.productionId,
            productionqty_base: recetaHistorica.baseQty,
            ruta
        });

    } catch (err) {
        console.error('❌ Error cargando receta/flujo:', err.message);
        res.status(500).json({
            error: 'Error cargando receta/flujo desde Lirion',
            detalle: err.message
        });
    }
});


app.get('/api/idempiere/motivos-merma', async (req, res) => {
    try {
        const result = await poolIdempiere.query(`SELECT cds_scrap_id as id, name, value FROM adempiere.cds_scrap WHERE isactive = 'Y' ORDER BY name ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/idempiere/motivos-ocurrencia', async (req, res) => {
    try {
        const result = await poolIdempiere.query(`SELECT cds_machinestop_id as id, name, value FROM adempiere.cds_machinestop WHERE isactive = 'Y' ORDER BY name ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.get('/api/idempiere/stock-detallado/:product_id', async (req, res) => {
    const { product_id } = req.params;

    try {
        const sql = `
            SELECT 
                s.m_product_id,
                s.m_locator_id,
                l.value AS bodega,
                l.m_warehouse_id,
                w.name AS almacen,
                s.m_attributesetinstance_id AS lote_id,
                COALESCE(
                    NULLIF(asi.description, ''),
                    NULLIF(STRING_AGG(DISTINCT NULLIF(ai.value, ''), ' / '), ''),
                    CASE 
                        WHEN s.m_attributesetinstance_id = 0 THEN 'Sin Lote'
                        ELSE 'Lote ' || s.m_attributesetinstance_id::text
                    END
                ) AS lote_nombre,
                SUM(s.qtyonhand) AS cantidad,
                uom.c_uom_id,
                uom.name AS uom_nombre
            FROM adempiere.m_storageonhand s
            JOIN adempiere.m_locator l ON l.m_locator_id = s.m_locator_id
            JOIN adempiere.m_warehouse w ON w.m_warehouse_id = l.m_warehouse_id
            JOIN adempiere.m_product p ON p.m_product_id = s.m_product_id
            LEFT JOIN adempiere.c_uom uom ON uom.c_uom_id = p.c_uom_id
            LEFT JOIN adempiere.m_attributesetinstance asi ON asi.m_attributesetinstance_id = s.m_attributesetinstance_id
            LEFT JOIN adempiere.m_attributeinstance ai
              ON ai.m_attributesetinstance_id = s.m_attributesetinstance_id
             AND ai.isactive = 'Y'
            WHERE s.m_product_id = $1
              AND l.m_warehouse_id = $2
              AND s.qtyonhand > 0
              AND l.isactive = 'Y'
              AND p.isactive = 'Y'
            GROUP BY 
                s.m_product_id,
                s.m_locator_id,
                l.value,
                l.m_warehouse_id,
                w.name,
                s.m_attributesetinstance_id,
                asi.description,
                uom.c_uom_id,
                uom.name
            HAVING SUM(s.qtyonhand) > 0
            ORDER BY w.name ASC, l.value ASC, lote_nombre ASC
        `;

        const result = await poolIdempiere.query(sql, [product_id, WAREHOUSE_PRODUCCION_ID]);

        res.json(result.rows.map(r => ({
            m_product_id: Number(r.m_product_id),
            m_locator_id: Number(r.m_locator_id),
            bodega: r.bodega,
            almacen: r.almacen,
            lote_id: Number(r.lote_id),
            lote_nombre: r.lote_nombre,
            cantidad: Number(r.cantidad),
            c_uom_id: r.c_uom_id ? Number(r.c_uom_id) : null,
            uom_nombre: r.uom_nombre
        })));

    } catch (err) {
        console.error('❌ Error cargando stock detallado:', err.message);
        res.status(500).json({ error: err.message });
    }
});


app.get('/api/idempiere/responsables', async (req, res) => {
    try {
        const result = await poolIdempiere.query(`SELECT ad_wf_responsible_id as id, name FROM adempiere.ad_wf_responsible WHERE isactive = 'Y' AND ad_client_id = 1000000 ORDER BY name ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/idempiere/insumos', async (req, res) => {
    try {
        const result = await poolIdempiere.query(`
            SELECT
                p.m_product_id as id,
                p.value as codigo,
                p.name as nombre,
                p.c_uom_id,
                u.name as uom_nombre
            FROM adempiere.m_product p
            LEFT JOIN adempiere.c_uom u ON u.c_uom_id = p.c_uom_id
            WHERE p.isactive = 'Y'
              AND (p.isstocked = 'Y' OR p.producttype = 'S')
            ORDER BY p.name ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ==========================================
// SOLICITUD INTERNA DE INSUMOS (OPERADOR -> SUPERVISOR)
// ==========================================
async function asegurarTablasSolicitudInsumos() {
    await db.run(`
        CREATE TABLE IF NOT EXISTS solicitudes_insumos (
            id INTEGER PRIMARY KEY AUTO_INCREMENT,
            op VARCHAR(60) NOT NULL,
            proceso_id INTEGER NULL,
            operador_id INTEGER NULL,
            adempiere_user_id INTEGER NULL,
            area_proceso VARCHAR(120) NULL,
            estado_pms VARCHAR(40) NOT NULL DEFAULT 'PENDIENTE_SUPERVISOR',
            estado_anterior_op VARCHAR(60) NULL,
            estado_anterior_proceso VARCHAR(60) NULL,
            observacion TEXT NULL,
            fecha_solicitud DATETIME NOT NULL,
            pausa_inicio DATETIME NOT NULL,
            pausa_fin DATETIME NULL,
            duracion_pausa_minutos INTEGER NULL,
            supervisor_id INTEGER NULL,
            fecha_respuesta_supervisor DATETIME NULL,
            comentario_supervisor TEXT NULL,
            m_movement_id NUMERIC(10,0) NULL,
            documentno VARCHAR(30) NULL,
            docstatus VARCHAR(2) NULL,
            docaction VARCHAR(2) NULL,
            respuesta_lirion TEXT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NULL
        )
    `);

    await db.run(`
        CREATE TABLE IF NOT EXISTS solicitudes_insumos_detalle (
            id INTEGER PRIMARY KEY AUTO_INCREMENT,
            solicitud_id INTEGER NOT NULL,
            m_product_id NUMERIC(10,0) NOT NULL,
            producto_codigo VARCHAR(80) NULL,
            producto_nombre VARCHAR(255) NULL,
            nombre_visual VARCHAR(255) NULL,
            cantidad_teorica NUMERIC NULL DEFAULT 0,
            cantidad_real_requerida NUMERIC NULL DEFAULT 0,
            cantidad NUMERIC NOT NULL DEFAULT 0,
            stock_disponible NUMERIC NULL DEFAULT 0,
            estado_stock VARCHAR(40) NULL,
            c_uom_id NUMERIC(10,0) NULL,
            uom_nombre VARCHAR(80) NULL,
            m_locator_id NUMERIC(10,0) NULL,
            m_locatorto_id NUMERIC(10,0) NULL,
            m_attributesetinstance_id NUMERIC(10,0) NULL DEFAULT 0,
            lote_nombre VARCHAR(255) NULL,
            bodega VARCHAR(120) NULL,
            almacen VARCHAR(120) NULL,
            m_movementline_id NUMERIC(10,0) NULL,
            line NUMERIC(10,0) NULL,
            created_at DATETIME NOT NULL
        )
    `);

    await db.run(`
        CREATE TABLE IF NOT EXISTS notificaciones_supervisor (
            id INTEGER PRIMARY KEY AUTO_INCREMENT,
            tipo VARCHAR(60) NOT NULL,
            titulo VARCHAR(255) NOT NULL,
            mensaje TEXT NULL,
            op VARCHAR(60) NULL,
            solicitud_id INTEGER NULL,
            proceso_id INTEGER NULL,
            operador_id INTEGER NULL,
            estado VARCHAR(40) NOT NULL DEFAULT 'PENDIENTE',
            created_at DATETIME NOT NULL,
            leida_at DATETIME NULL
        )
    `);

    // Si ya existían las tablas con la versión anterior, intentamos agregar columnas nuevas.
    // Los ALTER fallarán si la columna ya existe; esos errores se ignoran a propósito.
    const alters = [
        // Compatibilidad con tablas antiguas creadas antes del flujo de aprobación.
        `ALTER TABLE solicitudes_insumos ADD COLUMN proceso_id INTEGER NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN operador_id INTEGER NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN adempiere_user_id INTEGER NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN area_proceso VARCHAR(120) NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN estado_pms VARCHAR(40) NULL DEFAULT 'PENDIENTE_SUPERVISOR'`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN observacion TEXT NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN m_movement_id NUMERIC(10,0) NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN documentno VARCHAR(30) NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN docstatus VARCHAR(2) NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN docaction VARCHAR(2) NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN respuesta_lirion TEXT NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN created_at DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN updated_at DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN estado_anterior_op VARCHAR(60) NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN estado_anterior_proceso VARCHAR(60) NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN fecha_solicitud DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN pausa_inicio DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN pausa_fin DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN duracion_pausa_minutos INTEGER NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN supervisor_id INTEGER NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN fecha_respuesta_supervisor DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN comentario_supervisor TEXT NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN solicitud_id INTEGER NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN m_product_id NUMERIC(10,0) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN producto_codigo VARCHAR(80) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN producto_nombre VARCHAR(255) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN cantidad NUMERIC NULL DEFAULT 0`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN c_uom_id NUMERIC(10,0) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN uom_nombre VARCHAR(80) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN m_locator_id NUMERIC(10,0) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN m_locatorto_id NUMERIC(10,0) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN m_attributesetinstance_id NUMERIC(10,0) NULL DEFAULT 0`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN m_movementline_id NUMERIC(10,0) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN line NUMERIC(10,0) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN created_at DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN nombre_visual VARCHAR(255) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN cantidad_teorica NUMERIC NULL DEFAULT 0`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN cantidad_real_requerida NUMERIC NULL DEFAULT 0`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN stock_disponible NUMERIC NULL DEFAULT 0`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN estado_stock VARCHAR(40) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN lote_nombre VARCHAR(255) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN bodega VARCHAR(120) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN almacen VARCHAR(120) NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN fecha_inicio_pausa DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN fecha_fin_pausa DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos ADD COLUMN tiempo_pausa_minutos INTEGER NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN tipo VARCHAR(60) NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN titulo VARCHAR(255) NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN mensaje TEXT NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN op VARCHAR(60) NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN solicitud_id INTEGER NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN proceso_id INTEGER NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN operador_id INTEGER NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN estado VARCHAR(40) NULL DEFAULT 'PENDIENTE'`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN created_at DATETIME NULL`,
        `ALTER TABLE notificaciones_supervisor ADD COLUMN leida_at DATETIME NULL`
    ];

    for (const sql of alters) {
        try { await db.run(sql); } catch (_) { }
    }

    // Si estas columnas venían de una versión anterior como NOT NULL sin DEFAULT,
    // las dejamos compatibles para que no rompan inserts nuevos.
    const compat = [
        `ALTER TABLE solicitudes_insumos MODIFY COLUMN fecha_inicio_pausa DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos MODIFY COLUMN fecha_fin_pausa DATETIME NULL`,
        `ALTER TABLE solicitudes_insumos MODIFY COLUMN tiempo_pausa_minutos INTEGER NULL`
    ];

    for (const sql of compat) {
        try { await db.run(sql); } catch (_) { }
    }
}

async function obtenerColumnasTablaInterna(nombreTabla) {
    try {
        const columnas = await db.all(`SHOW COLUMNS FROM ${nombreTabla}`);
        return new Set((columnas || []).map(c => String(c.Field || c.field || '').toLowerCase()).filter(Boolean));
    } catch (err) {
        console.warn(`⚠️ No se pudieron leer columnas de ${nombreTabla}:`, err.message);
        return new Set();
    }
}

async function insertarSolicitudInsumosCabecera(data) {
    const columnas = await obtenerColumnasTablaInterna('solicitudes_insumos');

    // Compatibilidad con versiones anteriores de la tabla.
    // Algunos ambientes ya tenían fecha_inicio_pausa como NOT NULL sin default.
    if (columnas.has('fecha_inicio_pausa') && !data.fecha_inicio_pausa) {
        data.fecha_inicio_pausa = data.pausa_inicio || data.fecha_solicitud || data.created_at;
    }
    if (columnas.has('fecha_fin_pausa') && !data.fecha_fin_pausa) {
        data.fecha_fin_pausa = data.pausa_fin || null;
    }
    if (columnas.has('tiempo_pausa_minutos') && data.tiempo_pausa_minutos === undefined) {
        data.tiempo_pausa_minutos = data.duracion_pausa_minutos ?? null;
    }

    const campos = Object.keys(data).filter(c => columnas.has(c.toLowerCase()));

    if (campos.length === 0) {
        throw new Error('No se pudo reconocer ninguna columna válida de solicitudes_insumos. Revise la estructura de la tabla local.');
    }

    const placeholders = campos.map(() => '?').join(', ');
    const valores = campos.map(c => data[c]);

    return await db.run(`
        INSERT INTO solicitudes_insumos (${campos.join(', ')})
        VALUES (${placeholders})
    `, valores);
}

async function insertarRegistroFlexible(nombreTabla, data) {
    const columnas = await obtenerColumnasTablaInterna(nombreTabla);
    const campos = Object.keys(data).filter(c => columnas.has(c.toLowerCase()));

    if (campos.length === 0) {
        throw new Error(`No se pudo reconocer ninguna columna válida de ${nombreTabla}. Revise la estructura de la tabla local.`);
    }

    const placeholders = campos.map(() => '?').join(', ');
    const valores = campos.map(c => data[c]);

    return await db.run(`
        INSERT INTO ${nombreTabla} (${campos.join(', ')})
        VALUES (${placeholders})
    `, valores);
}

app.get('/api/idempiere/locators', async (req, res) => {
    // Se mantiene disponible para la futura aprobación del supervisor,
    // pero el operador ya no necesita seleccionar ubicaciones ni crear Lirion.
    try {
        const result = await poolIdempiere.query(`
            SELECT
                l.m_locator_id,
                l.value AS locator_value,
                l.x,
                l.y,
                l.z,
                w.m_warehouse_id,
                w.name AS warehouse_name
            FROM adempiere.m_locator l
            JOIN adempiere.m_warehouse w ON w.m_warehouse_id = l.m_warehouse_id
            WHERE l.isactive = 'Y'
              AND w.isactive = 'Y'
              AND l.ad_client_id = 1000000
            ORDER BY w.name ASC, l.value ASC
        `);

        res.json(result.rows.map(r => ({
            m_locator_id: Number(r.m_locator_id),
            value: r.locator_value,
            nombre: `${r.warehouse_name || 'Bodega'} / ${r.locator_value || r.m_locator_id}`,
            m_warehouse_id: r.m_warehouse_id ? Number(r.m_warehouse_id) : null,
            warehouse_name: r.warehouse_name
        })));
    } catch (err) {
        console.error('❌ Error cargando ubicaciones Lirion:', err.message);
        res.status(500).json({ error: err.message });
    }
});



// ==========================================
// BLOQUEO FLUJO ANTIGUO: OPERADOR YA NO SOLICITA INSUMOS
// ==========================================
app.post('/api/insumos/solicitud', (req, res) => {
    return res.status(403).json({
        success: false,
        error: 'La solicitud de insumos ahora debe ser creada por Supervisor desde Gestión. El operador ya no puede generar solicitudes de insumos.'
    });
});

app.post('/api/insumos/solicitud', autenticarPMSOpcional, async (req, res) => {
    const {
        op,
        proceso_id,
        operador_id,
        area_proceso,
        observacion,
        materiales,
        adempiere_user_id
    } = req.body || {};

    if (!op) return res.status(400).json({ error: 'Debe indicar la OP asociada a la solicitud de insumos.' });

    const lineasSolicitadas = parseJsonArraySeguro(materiales, []).filter((mat) =>
        Number(mat?.m_product_id) > 0 && numeroSeguro(mat?.cantidad_solicitada ?? mat?.cantidad) > 0
    );

    if (lineasSolicitadas.length === 0) {
        return res.status(400).json({ error: 'Debe ingresar una cantidad mayor a 0 en al menos un insumo.' });
    }

    try {
        await asegurarTablasSolicitudInsumos();

        const ahora = new Date();
        const fechaAhora = toMySQLDate(ahora);
        const operadorFinal = operador_id || req.user?.userId || req.user?.id || null;
        const adempiereUserFinal = adempiere_user_id || req.user?.adempiere_user_id || req.user?.lirion_ad_user_id || null;

        let estadoAnteriorOp = null;
        try {
            const orden = await db.get(`SELECT estado FROM ordenes_planificacion WHERE op = ? LIMIT 1`, [op]);
            estadoAnteriorOp = orden?.estado || null;
        } catch (_) { }

        let estadoAnteriorProceso = null;
        if (proceso_id) {
            try {
                const proceso = await db.get(`SELECT estado FROM procesos WHERE id = ? LIMIT 1`, [proceso_id]);
                estadoAnteriorProceso = proceso?.estado || null;
            } catch (_) { }
        }

        const local = await insertarSolicitudInsumosCabecera({
            op,
            proceso_id: proceso_id || null,
            operador_id: operadorFinal,
            adempiere_user_id: adempiereUserFinal,
            area_proceso: area_proceso || null,
            estado_pms: 'PENDIENTE_SUPERVISOR',
            estado_anterior_op: estadoAnteriorOp,
            estado_anterior_proceso: estadoAnteriorProceso,
            observacion: observacion || null,
            fecha_solicitud: fechaAhora,
            pausa_inicio: fechaAhora,
            fecha_inicio_pausa: fechaAhora,
            pausa_fin: null,
            fecha_fin_pausa: null,
            duracion_pausa_minutos: null,
            tiempo_pausa_minutos: null,
            created_at: fechaAhora,
            updated_at: fechaAhora
        });

        let solicitudId = local?.lastID || local?.insertId || null;
        if (!solicitudId) {
            const solicitudLocal = await db.get(
                `SELECT id FROM solicitudes_insumos WHERE op = ? ORDER BY id DESC LIMIT 1`,
                [op]
            );
            solicitudId = solicitudLocal?.id || null;
        }

        if (!solicitudId) {
            throw new Error('No se pudo obtener el ID local de la solicitud de insumos.');
        }

        for (const mat of lineasSolicitadas) {
            await insertarRegistroFlexible('solicitudes_insumos_detalle', {
                solicitud_id: solicitudId,
                m_product_id: Number(mat.m_product_id),
                producto_codigo: mat.codigo || mat.producto_codigo || null,
                producto_nombre: mat.nombre || mat.producto_nombre || null,
                nombre_visual: mat.nombre_visual || mat.nombre || mat.producto_nombre || String(mat.m_product_id),
                cantidad_teorica: numeroSeguro(mat.cantidad_teorica ?? mat.cantidad, 0),
                cantidad_real_requerida: numeroSeguro(mat.cantidad_real_requerida ?? mat.cantidad_real, 0),
                cantidad: numeroSeguro(mat.cantidad_solicitada ?? mat.cantidad, 0),
                stock_disponible: numeroSeguro(mat.stock_disponible, 0),
                estado_stock: mat.estado_stock || null,
                c_uom_id: mat.c_uom_id || null,
                uom_nombre: mat.uom_nombre || null,
                m_locator_id: mat.m_locator_id || null,
                m_locatorto_id: mat.m_locatorto_id || null,
                m_attributesetinstance_id: mat.m_attributesetinstance_id ?? 0,
                lote_nombre: mat.lote_nombre || null,
                bodega: mat.bodega || null,
                almacen: mat.almacen || null,
                created_at: fechaAhora
            });
        }

        await db.run(`UPDATE ordenes_planificacion SET estado = 'EN_ESPERA_APROBACION_INSUMOS' WHERE op = ?`, [op]);

        if (proceso_id) {
            await db.run(`UPDATE procesos SET estado = 'EN_ESPERA_APROBACION_INSUMOS' WHERE id = ?`, [proceso_id]);
        }

        const resumenInsumos = lineasSolicitadas
            .map(mat => `${mat.nombre_visual || mat.nombre || mat.m_product_id}: ${numeroSeguro(mat.cantidad_solicitada ?? mat.cantidad, 0)} ${mat.uom_nombre || ''}`.trim())
            .join(' | ')
            .substring(0, 1000);

        await insertarRegistroFlexible('notificaciones_supervisor', {
            tipo: 'SOLICITUD_INSUMOS',
            titulo: `Solicitud de insumos OP ${op}`,
            mensaje: `El operador solicitó insumos para ${area_proceso || 'la etapa actual'}. ${resumenInsumos}`,
            op,
            solicitud_id: solicitudId,
            proceso_id: proceso_id || null,
            operador_id: operadorFinal,
            estado: 'PENDIENTE',
            created_at: fechaAhora
        });

        res.json({
            success: true,
            message: `Solicitud de insumos enviada al supervisor. OP ${op} quedó en espera de aprobación.`,
            solicitud_id: solicitudId,
            op,
            estado_pms: 'PENDIENTE_SUPERVISOR',
            pausa_inicio: fechaAhora,
            lineas: lineasSolicitadas.length
        });
    } catch (err) {
        console.error('❌ Error guardando solicitud interna de insumos:', err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});



async function procesarSolicitudInsumosEnLirion(mMovementId, lirionToken) {
    if (!lirionToken) {
        throw new Error('No hay token REST activo de Lirion para procesar la solicitud de insumos. Cierre sesión e ingrese nuevamente.');
    }

    if (!mMovementId) {
        throw new Error('No se recibió el M_Movement_ID de la solicitud de insumos.');
    }

    // En este flujo personalizado, la primera vez que se presiona Completar (CO),
    // el ERP intercepta la acción, establece NOTIFICADO, envía un correo y
    // aborta el proceso, dejando el documento en Borrador (DR).
    return await httpsJsonRequest({
        hostname: '192.168.3.80',
        port: 8452,
        path: `/api/v1/models/m_movement/${mMovementId}`,
        method: 'PUT',
        token: lirionToken,
        body: {
            'doc-action': 'CO'
        }
    });
}

async function verificarMovimientoInsumos(mMovementId) {
    const result = await poolIdempiere.query(`
        SELECT
            m_movement_id,
            documentno,
            docstatus,
            docaction,
            processed,
            posted,
            processing,
            m_warehouse_id,
            m_warehouseto_id,
            poreference
        FROM adempiere.m_movement
        WHERE m_movement_id = $1
        LIMIT 1
    `, [mMovementId]);

    if (!result.rows.length) {
        throw new Error(`No se encontró M_Movement_ID ${mMovementId} después de procesar la solicitud.`);
    }

    return result.rows[0];
}

async function calcularDuracionPausaMinutos(pausaInicio, fechaFin = new Date()) {
    if (!pausaInicio) return null;
    const inicio = new Date(pausaInicio);
    if (isNaN(inicio.getTime())) return null;
    return Math.max(0, Math.round((fechaFin.getTime() - inicio.getTime()) / 60000));
}

async function restaurarEstadoOpYProcesoDesdeSolicitud(solicitud, fechaAhora, duracion) {
    const estadoOp = solicitud?.estado_anterior_op || 'EN_PROCESO';
    const estadoProceso = solicitud?.estado_anterior_proceso || 'EN_PROCESO';

    await db.run(`UPDATE ordenes_planificacion SET estado = ? WHERE op = ?`, [estadoOp, solicitud.op]);

    if (solicitud?.proceso_id) {
        await db.run(`UPDATE procesos SET estado = ? WHERE id = ?`, [estadoProceso, solicitud.proceso_id]);
    } else {
        await db.run(`UPDATE procesos SET estado = ? WHERE op = ? AND estado IN ('EN_ESPERA_APROBACION_INSUMOS','EN_ESPERA_INSUMOS')`, [estadoProceso, solicitud.op]);
    }
}

async function crearMovimientoInsumosEnLirionDesdeSolicitud({ solicitud, detalles, materialesAprobados, supervisorAdUserId, lirionToken }) {
    if (!lirionToken) throw new Error("Token de Lirion no proporcionado. Es requerido para la API REST.");

    const descripcion = String(
        solicitud.observacion || `Solicitud de insumos PMS | OP ${solicitud.op}${solicitud.area_proceso ? ' | Etapa ' + solicitud.area_proceso : ''}`
    ).substring(0, 255);

    // 1. Crear cabecera vía REST API
    let mMovementId;
    let documentNo;
    try {
        const headerRes = await httpsJsonRequest({
            hostname: '192.168.3.80', port: 8452, path: '/api/v1/models/m_movement', method: 'POST',
            token: lirionToken,
            body: {
                "AD_Org_ID": 1000000,
                "C_DocType_ID": 1000099, // 1000099 = Solicitud de Insumos
                "Description": descripcion,
                "SalesRep_ID": supervisorAdUserId,
                "M_Warehouse_ID": 1000000, // Bodega Principal
                "M_WarehouseTo_ID": 1000002 // Producción
            }
        });
        mMovementId = headerRes.id;
        documentNo = headerRes.DocumentNo || headerRes.documentNo;
    } catch (e) {
        throw new Error(`Fallo al crear cabecera en Lirion (REST): ${e.message}`);
    }

    // 2. Crear líneas vía REST API
    const lineasCreadas = [];
    const client = await poolIdempiere.connect();

    try {
        for (const mat of materialesAprobados) {
            const detalle = detalles.find(d => Number(d.id) === Number(mat.detalle_id)) || detalles.find(d => Number(d.m_product_id) === Number(mat.m_product_id));
            if (!detalle) throw new Error(`No se encontró el detalle local para el producto ${mat.m_product_id}.`);

            const productId = Number(detalle.m_product_id);
            const cantidad = numeroSeguro(
                mat.cantidad_aprobada ?? mat.cantidad_solicitada ?? mat.cantidad ??
                detalle.cantidad_aprobada ?? detalle.cantidad_solicitada ?? detalle.cantidad ??
                detalle.cantidad_sugerida, 0
            );

            const asiId = mat.m_attributesetinstance_id === null || mat.m_attributesetinstance_id === undefined || mat.m_attributesetinstance_id === ''
                ? Number(detalle.m_attributesetinstance_id || 0) : Number(mat.m_attributesetinstance_id);

            if (!productId || cantidad <= 0) continue;

            // Consultar producto para devolver información visual al PMS
            const prod = await client.query(`
                SELECT p.value, p.name, p.c_uom_id, u.name AS uom_nombre
                FROM adempiere.m_product p
                LEFT JOIN adempiere.c_uom u ON u.c_uom_id = p.c_uom_id
                WHERE p.m_product_id = $1 LIMIT 1
            `, [productId]);

            if (!prod.rows.length) throw new Error(`No se encontró el producto ${productId} en Lirion.`);
            const cUomId = Number(detalle.c_uom_id || prod.rows[0].c_uom_id || 100);

            let locatorOrigen = Number(mat.m_locator_id || mat.locator_origen_id || detalle.m_locator_id);
            let locatorDestino = Number(mat.m_locatorto_id || mat.locator_destino_id || detalle.m_locatorto_id);

            if (!locatorOrigen || locatorOrigen === 1006780) {
                locatorOrigen = 1000000;
            }
            if (!locatorDestino) {
                locatorDestino = 1006780;
            }

            const descLinea = String(`PMS OP ${detalle.op_origen || solicitud.op}${(detalle.area_origen || solicitud.area_proceso) ? ' | ' + (detalle.area_origen || solicitud.area_proceso) : ''}`).substring(0, 255);

            // Inserción de la línea en Lirion mediante REST API
            const lineRes = await httpsJsonRequest({
                hostname: '192.168.3.80', port: 8452, path: '/api/v1/models/m_movementline', method: 'POST',
                token: lirionToken,
                body: {
                    "M_Movement_ID": mMovementId,
                    "M_Product_ID": productId,
                    "MovementQty": cantidad,
                    "Description": descLinea,
                    "M_AttributeSetInstance_ID": asiId || 0,
                    "M_Locator_ID": locatorOrigen,
                    "M_LocatorTo_ID": locatorDestino
                }
            });

            lineasCreadas.push({
                detalle_id: detalle.id,
                m_movementline_id: lineRes.id,
                m_product_id: productId,
                producto_codigo: prod.rows[0].value,
                producto_nombre: prod.rows[0].name,
                cantidad,
                c_uom_id: cUomId,
                uom_nombre: prod.rows[0].uom_nombre,
                m_locator_id: locatorOrigen,
                m_locatorto_id: locatorDestino,
                m_attributesetinstance_id: asiId || 0,
                line: lineRes.Line || (lineasCreadas.length + 1) * 10
            });
        }

        if (lineasCreadas.length === 0) {
            throw new Error('No hay líneas válidas para aprobar la solicitud de insumos.');
        }

        // 3. Completar documento para gatillar flujos de trabajo
        let respuestaProceso = null;
        let errorPreparacion = null;

        try {
            respuestaProceso = await procesarSolicitudInsumosEnLirion(mMovementId, lirionToken);
        } catch (prepErr) {
            // Es esperado que falle por inventario negativo si la bodega no tiene stock en el momento,
            // pero el flujo ya debió haber guardado el NOTIFICADO
            errorPreparacion = prepErr?.message || 'Lirion rechazó la acción Preparar.';
        }

        let estadoFinal = await verificarMovimientoInsumos(mMovementId);
        let preparada = (['DR', 'IN'].includes(String(estadoFinal.docstatus || '').toUpperCase()) && String(estadoFinal.poreference || '').toUpperCase() === 'NOTIFICADO') ||
            (String(estadoFinal.docstatus || '').toUpperCase() === 'CO' && String(estadoFinal.processed || '').toUpperCase() === 'Y');

        if (!preparada) {
            const detallePrep = errorPreparacion ? ` Error REST: ${errorPreparacion}` : ' REST respondió, pero Lirion no completó el documento.';
            return {
                mMovementId, documentNo, lineasCreadas, respuestaProceso, estadoFinal, preparada: false,
                errorPreparacion: `Lirion creó la solicitud ${documentNo}, pero el flujo no la dejó como NOTIFICADA. Estado=${estadoFinal.docstatus}, DocAction=${estadoFinal.docaction}, POReference=${estadoFinal.poreference}.${detallePrep}`
            };
        }

        return { mMovementId, documentNo, lineasCreadas, respuestaProceso, estadoFinal, preparada: true, errorPreparacion: null };
    } finally {
        client.release();
    }
}

app.get('/api/insumos/solicitudes-pendientes', async (req, res) => {
    try {
        await asegurarTablasSolicitudInsumos();

        const solicitudes = await db.all(`
            SELECT
                s.*,
                u.nombre AS operador_nombre,
                n.estado AS estado_notificacion
            FROM solicitudes_insumos s
            LEFT JOIN usuarios u ON u.id = s.operador_id
            LEFT JOIN notificaciones_supervisor n ON n.solicitud_id = s.id AND n.tipo = 'SOLICITUD_INSUMOS'
            WHERE s.estado_pms = 'PENDIENTE_SUPERVISOR'
            ORDER BY s.fecha_solicitud ASC, s.id ASC
        `);

        const salida = [];
        for (const sol of solicitudes || []) {
            const detalle = await db.all(`
                SELECT *
                FROM solicitudes_insumos_detalle
                WHERE solicitud_id = ?
                ORDER BY id ASC
            `, [sol.id]);

            salida.push({
                ...sol,
                detalle: (detalle || []).map(d => ({
                    ...d,
                    cantidad: numeroSeguro(d.cantidad, 0),
                    cantidad_teorica: numeroSeguro(d.cantidad_teorica, 0),
                    cantidad_real_requerida: numeroSeguro(d.cantidad_real_requerida, 0),
                    stock_disponible: numeroSeguro(d.stock_disponible, 0),
                    cantidad_aprobada: numeroSeguro(d.cantidad, 0),
                    locator_origen_id: d.m_locator_id || null,
                    locator_destino_id: d.m_locatorto_id || null
                }))
            });
        }

        res.json(salida);
    } catch (err) {
        console.error('❌ Error cargando solicitudes de insumos pendientes:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/insumos/solicitud/:id/aprobar', autenticarPMS, async (req, res) => {
    const { id } = req.params;
    const { materiales, comentario_supervisor, adempiere_user_id } = req.body || {};

    try {
        await asegurarTablasSolicitudInsumos();

        const solicitud = await db.get(`SELECT * FROM solicitudes_insumos WHERE id = ? LIMIT 1`, [id]);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud de insumos no encontrada.' });
        if (solicitud.estado_pms !== 'PENDIENTE_SUPERVISOR') {
            return res.status(400).json({ error: `La solicitud ya no está pendiente. Estado actual: ${solicitud.estado_pms}` });
        }

        const detalles = await db.all(`SELECT * FROM solicitudes_insumos_detalle WHERE solicitud_id = ? ORDER BY id ASC`, [id]);
        const materialesAprobados = parseJsonArraySeguro(materiales, []).filter(m => Number(m?.m_product_id) > 0 && numeroSeguro(m?.cantidad_aprobada ?? m?.cantidad, 0) > 0);
        if (materialesAprobados.length === 0) {
            return res.status(400).json({ error: 'Debe aprobar al menos un insumo con cantidad mayor a 0.' });
        }

        const tokenLirion = await obtenerTokenLirionParaCompletar(req);
        if (!tokenLirion) {
            return res.status(400).json({ error: 'No hay token REST activo de Lirion. Cierre sesión e ingrese nuevamente.' });
        }

        const supervisorAdUserId = Number(adempiere_user_id || req.user?.adempiere_user_id || req.user?.lirion_ad_user_id || req.user?.ad_user_id);
        if (!Number.isFinite(supervisorAdUserId) || supervisorAdUserId <= 0 || supervisorAdUserId === 100) {
            return res.status(400).json({ error: 'No se pudo determinar el AD_User_ID real del supervisor en Lirion.' });
        }

        const creado = await crearMovimientoInsumosEnLirionDesdeSolicitud({
            solicitud,
            detalles,
            materialesAprobados,
            supervisorAdUserId,
            lirionToken: tokenLirion
        });

        const ahora = new Date();
        const fechaAhora = toMySQLDate(ahora);

        for (const linea of creado.lineasCreadas) {
            await db.run(`
                UPDATE solicitudes_insumos_detalle
                SET m_movementline_id = ?, m_locator_id = ?, m_locatorto_id = ?, m_attributesetinstance_id = ?, c_uom_id = ?, uom_nombre = ?, line = ?
                WHERE id = ?
            `, [
                linea.m_movementline_id,
                linea.m_locator_id,
                linea.m_locatorto_id,
                linea.m_attributesetinstance_id,
                linea.c_uom_id,
                linea.uom_nombre,
                linea.line,
                linea.detalle_id
            ]);
        }

        const preparadaLirion = !!creado.preparada;

        await db.run(`
            UPDATE solicitudes_insumos
            SET estado_pms = ?,
                supervisor_id = ?,
                fecha_respuesta_supervisor = ?,
                comentario_supervisor = ?,
                m_movement_id = ?,
                documentno = ?,
                docstatus = ?,
                docaction = ?,
                respuesta_lirion = ?,
                updated_at = ?
            WHERE id = ?
        `, [
            preparadaLirion ? 'APROBADA_SUPERVISOR' : 'BORRADOR_LIRION_NO_PREPARADO',
            supervisorAdUserId,
            fechaAhora,
            comentario_supervisor || null,
            creado.mMovementId,
            creado.documentNo,
            creado.estadoFinal?.docstatus || null,
            creado.estadoFinal?.docaction || null,
            JSON.stringify({ proceso: creado.respuestaProceso, estado: creado.estadoFinal, errorPreparacion: creado.errorPreparacion || null }).substring(0, 5000),
            fechaAhora,
            id
        ]);

        if (preparadaLirion) {
            await db.run(`UPDATE ordenes_planificacion SET estado = 'EN_ESPERA_INSUMOS' WHERE op = ?`, [solicitud.op]);
            if (solicitud.proceso_id) {
                await db.run(`UPDATE procesos SET estado = 'EN_ESPERA_INSUMOS' WHERE id = ?`, [solicitud.proceso_id]);
            }
        }

        await db.run(`
            UPDATE notificaciones_supervisor
            SET estado = ?, leida_at = ?
            WHERE solicitud_id = ? AND tipo = 'SOLICITUD_INSUMOS'
        `, [preparadaLirion ? 'APROBADA' : 'BORRADOR_LIRION_NO_PREPARADO', fechaAhora, id]);

        if (!preparadaLirion) {
            return res.status(409).json({
                success: false,
                error: creado.errorPreparacion || `Lirion creó la solicitud ${creado.documentNo}, pero no la completó.`,
                m_movement_id: creado.mMovementId,
                documentno: creado.documentNo,
                estado_lirion: creado.estadoFinal,
                lineas: creado.lineasCreadas.length
            });
        }

        res.json({
            success: true,
            message: `La solicitud fue creada y notificada a bodega exitosamente. Movimiento ${creado.documentNo}.`,
            m_movement_id: creado.mMovementId,
            documentno: creado.documentNo,
            estado_lirion: creado.estadoFinal,
            lineas: creado.lineasCreadas.length
        });
    } catch (err) {
        console.error('❌ Error aprobando solicitud de insumos:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/insumos/solicitud/:id/rechazar', autenticarPMS, async (req, res) => {
    const { id } = req.params;
    const { comentario_supervisor, adempiere_user_id } = req.body || {};

    try {
        await asegurarTablasSolicitudInsumos();

        const solicitud = await db.get(`SELECT * FROM solicitudes_insumos WHERE id = ? LIMIT 1`, [id]);
        if (!solicitud) return res.status(404).json({ error: 'Solicitud de insumos no encontrada.' });
        if (solicitud.estado_pms !== 'PENDIENTE_SUPERVISOR') {
            return res.status(400).json({ error: `La solicitud ya no está pendiente. Estado actual: ${solicitud.estado_pms}` });
        }

        const supervisorId = Number(adempiere_user_id || req.user?.adempiere_user_id || req.user?.lirion_ad_user_id || req.user?.ad_user_id || req.user?.userId || req.user?.id || 0) || null;
        const ahora = new Date();
        const fechaAhora = toMySQLDate(ahora);
        const duracion = await calcularDuracionPausaMinutos(solicitud.pausa_inicio, ahora);

        await db.run(`
            UPDATE solicitudes_insumos
            SET estado_pms = 'RECHAZADA_SUPERVISOR',
                supervisor_id = ?,
                fecha_respuesta_supervisor = ?,
                comentario_supervisor = ?,
                pausa_fin = ?,
                duracion_pausa_minutos = ?,
                updated_at = ?
            WHERE id = ?
        `, [
            supervisorId,
            fechaAhora,
            comentario_supervisor || null,
            fechaAhora,
            duracion,
            fechaAhora,
            id
        ]);

        await restaurarEstadoOpYProcesoDesdeSolicitud(solicitud, fechaAhora, duracion);

        await db.run(`
            UPDATE notificaciones_supervisor
            SET estado = 'RECHAZADA', leida_at = ?
            WHERE solicitud_id = ? AND tipo = 'SOLICITUD_INSUMOS'
        `, [fechaAhora, id]);

        res.json({
            success: true,
            message: `Solicitud de insumos rechazada. OP ${solicitud.op} volvió a su estado anterior.`,
            duracion_pausa_minutos: duracion
        });
    } catch (err) {
        console.error('❌ Error rechazando solicitud de insumos:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch('/api/insumos/reanudar-op/:op', async (req, res) => {
    const { op } = req.params;
    try {
        const ahora = new Date();
        const fechaAhora = toMySQLDate(ahora);

        const solicitud = await db.get(`
            SELECT id, pausa_inicio
            FROM solicitudes_insumos
            WHERE op = ?
              AND estado_pms IN ('PENDIENTE_SUPERVISOR', 'APROBADA_SUPERVISOR', 'EN_ESPERA_APROBACION_INSUMOS')
            ORDER BY id DESC
            LIMIT 1
        `, [op]);

        let duracion = null;
        if (solicitud?.pausa_inicio) {
            const inicio = new Date(solicitud.pausa_inicio);
            if (!isNaN(inicio.getTime())) {
                duracion = Math.max(0, Math.round((ahora.getTime() - inicio.getTime()) / 60000));
            }
        }

        if (solicitud?.id) {
            await db.run(`
                UPDATE solicitudes_insumos
                SET pausa_fin = ?, duracion_pausa_minutos = ?, updated_at = ?
                WHERE id = ?
            `, [fechaAhora, duracion, fechaAhora, solicitud.id]);
        }

        await db.run(`UPDATE ordenes_planificacion SET estado = 'EN_PROCESO' WHERE op = ? AND estado = 'EN_ESPERA_APROBACION_INSUMOS'`, [op]);
        await db.run(`UPDATE procesos SET estado = 'EN_PROCESO' WHERE op = ? AND estado = 'EN_ESPERA_APROBACION_INSUMOS'`, [op]);
        res.json({ success: true, message: `OP ${op} reanudada.`, duracion_pausa_minutos: duracion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/idempiere/maquinas', async (req, res) => {
    try {
        const result = await poolIdempiere.query(`
            SELECT
                a_asset_id,
                value as codigo,
                name as nombre,
                a_asset_group_id
            FROM adempiere.a_asset
            WHERE isactive = 'Y'
              AND a_asset_group_id = 1000028
            ORDER BY name ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Error cargando máquinas desde Lirion:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 🔥 CREACIÓN DE WORKFLOW Y PRODUCCIÓN EN LIRION

// 🔥 CREACIÓN DE WORKFLOW Y PRODUCCIÓN EN LIRION
// Crea AD_Workflow/AD_WF_Node/PP_WF_Node_* y M_Production en borrador.
// NO ejecuta DocAction ni completa el documento. Eso se verá en una etapa posterior.
app.post('/api/idempiere/crear-workflow', autenticarPMSOpcional, async (req, res) => {
    const {
        producto_codigo,
        producto_nombre,
        ruta_tecnica,
        usuario_nombre,
        op,
        cantidad_planificada,
        crear_receta,
        detalle_op,
        adempiere_user_id
    } = req.body;

    let creadorId = null;
    const autorSeguro = (usuario_nombre || req.user?.nombre || 'SISTEMA').substring(0, 20).toUpperCase();

    let ruta = [];
    try {
        ruta = JSON.parse(ruta_tecnica || '[]');
    } catch (e) {
        return res.status(400).json({ error: 'Ruta técnica inválida.' });
    }

    if (!ruta || ruta.length === 0) {
        return res.status(400).json({ error: 'Ruta vacía' });
    }

    const rutaNormalizada = ruta.map((etapa, index) => {
        const nombreEtapa = etapa.nombre_etapa || etapa.area || `Etapa ${index + 1}`;

        return {
            ...etapa,
            nombre_etapa: nombreEtapa,
            area: nombreEtapa,
            value_etapa: etapa.value_etapa || normalizarValueEtapa(nombreEtapa),
            maquina_id: null,
            responsable_id: etapa.responsable_id ? Number(etapa.responsable_id) : null,
            materiales: (etapa.materiales || []).map((mat) => ({
                ...mat,
                m_product_id: mat.m_product_id ? Number(mat.m_product_id) : null,
                m_locator_id: null,
                m_attributesetinstance_id: null,
                c_uom_id: mat.c_uom_id ? Number(mat.c_uom_id) : null,
                cantidad: Number(mat.cantidad || 0),
                cantidad_base: Number(mat.cantidad_base || 0)
            }))
        };
    });


    const totalInsumosValidos = rutaNormalizada.reduce((total, etapa) => {
        return total + (etapa.materiales || []).filter(mat =>
            mat.m_product_id && Number(mat.cantidad || 0) > 0
        ).length;
    }, 0);

    if (totalInsumosValidos === 0) {
        return res.status(400).json({
            success: false,
            error: 'La ruta técnica llegó sin insumos válidos.',
            detalle: 'No se creará M_Production porque quedaría solamente con el producto final. Revise que las etapas tengan materiales con cantidad mayor a 0.'
        });
    }

    console.log('📦 Ruta recibida para OP:', op, rutaNormalizada.map(etapa => ({
        etapa: etapa.nombre_etapa || etapa.area,
        materiales: (etapa.materiales || []).map(mat => ({
            producto: mat.nombre_visual || mat.m_product_id,
            m_product_id: mat.m_product_id,
            cantidad: mat.cantidad,
            locator: mat.m_locator_id,
            asi: mat.m_attributesetinstance_id
        }))
    })));

    const client = await poolIdempiere.connect();
    let committed = false;
    let nextProdID = null;
    let workflowIdToUse = null;

    try {
        await client.query('BEGIN');

        try {
            creadorId = await resolverCreadorLirionDesdeRequest(req, client);
        } catch (e) {
            creadorId = Number(adempiere_user_id);
        }

        if (!creadorId || Number.isNaN(creadorId) || creadorId === 100) {
            throw new Error('No se pudo determinar el usuario real de Lirion. No se creará la OP con SuperUser. Cierre sesión y vuelva a ingresar.');
        }

        console.log(`👤 Creando OP ${op} con AD_User_ID Lirion: ${creadorId} (${req.user?.username || req.user?.nombre || usuario_nombre || 'sin usuario'})`);

        const resProducto = await client.query(`
            SELECT m_product_id, c_uom_id
            FROM adempiere.m_product
            WHERE value = $1
              AND isactive = 'Y'
            LIMIT 1
        `, [producto_codigo]);

        if (resProducto.rows.length === 0) {
            throw new Error('Producto no encontrado en Lirion');
        }

        const { m_product_id, c_uom_id } = resProducto.rows[0];

        if (crear_receta) {
            await client.query(`
                UPDATE adempiere.ad_workflow
                SET isactive = 'N', updated = NOW(), updatedby = $2
                WHERE value = $1
                  AND isactive = 'Y'
            `, [producto_codigo, creadorId]);

            const resWFID = await client.query(`SELECT COALESCE(MAX(ad_workflow_id), 0) + 1 as next_id FROM adempiere.ad_workflow`);
            const nextWFID = resWFID.rows[0].next_id;
            workflowIdToUse = nextWFID;

            const nombreWorkflowUnico = await construirNombreWorkflowUnico(
                client,
                producto_nombre,
                producto_codigo,
                op
            );

            await client.query(`
                INSERT INTO adempiere.ad_workflow (
                    ad_workflow_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
                    name, description, accesslevel, entitytype, author, version, duration, cost, 
                    workingtime, waitingtime, publishstatus, value, isdefault, workflowtype, isvalid, 
                    s_resource_id, qtybatchsize, isbetafunctionality, yield, ad_workflow_uu, copyfrom
                ) VALUES (
                    $1, 1000000, 1000000, 'Y', NOW(), $2, NOW(), $2,
                    $3, 'Receta Maestra PMS', '1', 'U', $4, 0, 0, 0,
                    0, 0, 'U', $5, 'N', 'M', 'Y',
                    1000009, 1, 'N', 100, $6, 'N'
                )
            `, [nextWFID, creadorId, nombreWorkflowUnico, autorSeguro, producto_codigo, uuidv4()]);

            let primerNodoID = null;
            const nodosCreados = [];

            for (let i = 0; i < rutaNormalizada.length; i++) {
                const paso = rutaNormalizada[i];

                const resNextNodeID = await client.query(`SELECT COALESCE(MAX(ad_wf_node_id), 0) + 1 as next_id FROM adempiere.ad_wf_node`);
                const newNodeID = resNextNodeID.rows[0].next_id;

                if (i === 0) primerNodoID = newNodeID;
                nodosCreados.push(newNodeID);

                await client.query(`
                    INSERT INTO adempiere.ad_wf_node (
                        ad_wf_node_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
                        name, ad_workflow_id, iscentrallymaintained, action, entitytype, xposition, yposition,
                        "limit", duration, cost, workingtime, waitingtime, ad_wf_responsible_id, joinelement, 
                        splitelement, docaction, value, ismilestone, issubcontracting, unitscycles, yield,
                        ad_wf_node_uu, isattacheddocumenttoemail
                    ) VALUES (
                        $1, 1000000, 1000000, 'Y', NOW(), $2, NOW(), $2,
                        $3, $4, 'Y', 'Z', 'U', $5, 100,
                        0, 0, 0, 0, 0, $6, 'X',
                        'X', 'CO', $7, 'N', 'N', 0, 100,
                        $8, 'Y'
                    )
                `, [
                    newNodeID,
                    creadorId,
                    String(paso.nombre_etapa || paso.area || `Paso ${i + 1}`).substring(0, 60),
                    nextWFID,
                    i * 150,
                    paso.responsable_id || 1000018,
                    String(paso.value_etapa || normalizarValueEtapa(paso.nombre_etapa || paso.area || `PASO_${i + 1}`)).substring(0, 40),
                    uuidv4()
                ]);
                // Nuevo flujo: la máquina ya no se asigna en Planificación.
                // El operador la seleccionará al iniciar la etapa.

                if (paso.materiales && paso.materiales.length > 0) {
                    for (let j = 0; j < paso.materiales.length; j++) {
                        const mat = paso.materiales[j];

                        if (!mat.m_product_id) continue;

                        const resNextMatID = await client.query(`SELECT COALESCE(MAX(pp_wf_node_product_id), 0) + 1 as next_id FROM adempiere.pp_wf_node_product`);

                        const qtyBase = Number(mat.cantidad_base) > 0
                            ? Number(mat.cantidad_base)
                            : (Math.abs(Number(mat.cantidad) || 0) / (Number(cantidad_planificada) || 1));

                        await client.query(`
                            INSERT INTO adempiere.pp_wf_node_product (
                                pp_wf_node_product_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
                                ad_wf_node_id, m_product_id, qty, seqno, entitytype, configurationlevel, issubcontracting, yield,
                                pp_wf_node_product_uu, issubproduct
                            ) VALUES (
                                $1, 1000000, 1000000, 'Y', NOW(), $2, NOW(), $2,
                                $3, $4, $5, $6, 'U', 'S', 'N', 100,
                                $7, 'N'
                            )
                        `, [
                            resNextMatID.rows[0].next_id,
                            creadorId,
                            newNodeID,
                            mat.m_product_id,
                            qtyBase,
                            (j + 1) * 10,
                            uuidv4()
                        ]);
                    }
                }
            }

            for (let i = 0; i < nodosCreados.length - 1; i++) {
                const resNextTransID = await client.query(`SELECT COALESCE(MAX(ad_wf_nodenext_id), 0) + 1 as next FROM adempiere.ad_wf_nodenext`);

                await client.query(`
                    INSERT INTO adempiere.ad_wf_nodenext (
                        ad_wf_nodenext_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
                        ad_wf_node_id, ad_wf_next_id, description, seqno, entitytype, isstduserworkflow, ad_wf_nodenext_uu
                    ) VALUES (
                        $1, 1000000, 1000000, 'Y', NOW(), $2, NOW(), $2,
                        $3, $4, $5, $6, 'D', 'N', $7
                    )
                `, [
                    resNextTransID.rows[0].next,
                    creadorId,
                    nodosCreados[i],
                    nodosCreados[i + 1],
                    `Transición ${i + 1}-${i + 2}`,
                    (i + 1) * 10,
                    uuidv4()
                ]);
            }

            if (primerNodoID) {
                await client.query(
                    `UPDATE adempiere.ad_workflow SET ad_wf_node_id = $1, updated = NOW(), updatedby = $2 WHERE ad_workflow_id = $3`,
                    [primerNodoID, creadorId, nextWFID]
                );
            }
        } else {
            const existingWf = await client.query(`
                SELECT ad_workflow_id
                FROM adempiere.ad_workflow
                WHERE value = $1
                  AND isactive = 'Y'
                ORDER BY updated DESC, created DESC
                LIMIT 1
            `, [producto_codigo]);

            workflowIdToUse = existingWf.rows.length > 0 ? existingWf.rows[0].ad_workflow_id : null;
        }

        // Nuevo flujo: Planificación no valida stock/lote.
        // El operador elegirá ubicación y lote por insumo antes de consumir.

        // Validación adicional en backend: no permitir documentno duplicado.
        const existeOP = await client.query(`
            SELECT 1
            FROM adempiere.m_production
            WHERE regexp_replace(UPPER(TRIM(documentno)), '[^A-Z0-9]', '', 'g') =
                  regexp_replace(UPPER(TRIM($1)), '[^A-Z0-9]', '', 'g')
            LIMIT 1
        `, [op]);

        if (existeOP.rows.length > 0) {
            throw new Error(`La OP ${op} ya existe en Lirion.`);
        }

        const resProdID = await client.query(`SELECT COALESCE(MAX(m_production_id), 0) + 1 as next_id FROM adempiere.m_production`);
        nextProdID = resProdID.rows[0].next_id;

        const descripcionProduccion = String(detalle_op || '').trim()
            || `${op}	${producto_codigo}	${producto_nombre}	${Number(cantidad_planificada) || 0}`;

        await client.query(`
            INSERT INTO adempiere.m_production (
                m_production_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
                name, description, movementdate, iscreated, posted, processed, documentno, m_product_id, 
                m_locator_id, productionqty, datepromised, iscomplete, isuseproductionplan, docaction, 
                docstatus, c_doctype_id, c_uom_id, qtyentered, m_production_uu
            ) VALUES (
                $1, 1000000, 1000000, 'Y', NOW(), $2, NOW(), $2,
                $3, $4, NOW(), 'Y', 
                'N', 'N', $5, $6, 1006780, $7, NOW(), 'N', 'N', 'CO', 
                'DR', 1000460, $8, 0, $9
            )
        `, [
            nextProdID,
            creadorId,
            op,
            descripcionProduccion,
            op,
            m_product_id,
            Number(cantidad_planificada) || 0,
            c_uom_id,
            uuidv4()
        ]);

        const resNextLineID = await client.query(`SELECT COALESCE(MAX(m_productionline_id), 0) + 1 as next FROM adempiere.m_productionline`);
        let currentLineID = resNextLineID.rows[0].next;

        await client.query(`
            INSERT INTO adempiere.m_productionline (
                m_productionline_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
                m_production_id, line, m_product_id, m_locator_id, movementqty, plannedqty,
                isendproduct, m_attributesetinstance_id, m_productionline_uu, processed
            ) VALUES (
                $1, 1000000, 1000000, 'Y', NOW(), $2, NOW(), $2,
                $3, 10, $4, 1006780, $5, $5,
                'Y', 0, $6, 'N'
            )
        `, [
            currentLineID++,
            creadorId,
            nextProdID,
            m_product_id,
            Number(cantidad_planificada) || 0,
            uuidv4()
        ]);
        // En planificación SÍ se insertan las líneas teóricas de consumo,
        // pero sin lote real seleccionado.
        // El operador elegirá ubicación/lote por insumo en planta antes de consumir.
        // Para que Lirion muestre la receta completa en borrador usamos:
        // - ubicación temporal/default de producción: 1006780
        // - instancia de atributos/lote: 0 = sin lote asignado
        // - cantidad negativa para líneas de consumo
        const locatorTemporalPlanificacion = 1006780;
        let nroLineaContador = 20;

        for (const etapa of rutaNormalizada) {
            for (const mat of (etapa.materiales || [])) {
                if (!mat.m_product_id || Number(mat.cantidad || 0) <= 0) continue;

                const qtyConsumo = Number(mat.cantidad) * -1;
                const nombreEtapaLinea = etapa.area || etapa.nombre_etapa || 'Etapa';

                await client.query(`
                    INSERT INTO adempiere.m_productionline (
                        m_productionline_id, ad_client_id, ad_org_id, isactive, created, createdby, updated, updatedby,
                        m_production_id, line, m_product_id, m_locator_id, movementqty, plannedqty,
                        isendproduct, m_attributesetinstance_id, description, m_productionline_uu, processed
                    ) VALUES (
                        $1, 1000000, 1000000, 'Y', NOW(), $2, NOW(), $2,
                        $3, $4, $5, $6, $7, $7,
                        'N', 0, $8, $9, 'N'
                    )
                `, [
                    currentLineID++,
                    creadorId,
                    nextProdID,
                    nroLineaContador,
                    mat.m_product_id,
                    locatorTemporalPlanificacion,
                    qtyConsumo,
                    `Consumo teórico PMS - ${nombreEtapaLinea}. Lote/ubicación real pendiente de operador.`,
                    uuidv4()
                ]);

                nroLineaContador += 10;
            }
        }

        await client.query('COMMIT');
        committed = true;
        const estadoBorrador = await verificarProduccionProcesada(nextProdID);

        return res.json({
            success: true,
            workflow_id: workflowIdToUse,
            production_id: nextProdID,
            documentno: op,
            docstatus: estadoBorrador.docstatus,
            processed: estadoBorrador.processed,
            message: 'Producción creada en borrador en Lirion. El PMS queda en proceso hasta el cierre final de Planificación.'
        });

    } catch (err) {
        if (!committed) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {
                console.error('⚠️ Rollback no ejecutado:', rollbackErr.message);
            }
        }

        console.error('❌ Error iDempiere creando borrador:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});


// ==========================================
// RUTAS LOCALES MYSQL PLANIFICACION Y GESTION
// ==========================================

async function tablaTieneColumnaLocal(nombreTabla, nombreColumna) {
    // Este backend usa MySQL/MariaDB para el PMS local.
    // No usar PRAGMA aquí, porque PRAGMA es de SQLite y provoca error de sintaxis en MySQL.
    try {
        const columnas = await db.all(
            `SELECT COLUMN_NAME AS name
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = ?
               AND COLUMN_NAME = ?`,
            [nombreTabla, nombreColumna]
        );

        return Array.isArray(columnas) && columnas.length > 0;
    } catch (errInfoSchema) {
        try {
            const columnas = await db.all(`SHOW COLUMNS FROM ${nombreTabla} LIKE ?`, [nombreColumna]);
            return Array.isArray(columnas) && columnas.length > 0;
        } catch (errShowColumns) {
            console.warn(`⚠️ No se pudo verificar columna ${nombreColumna} en ${nombreTabla}:`, errShowColumns.message);
            return false;
        }
    }
}

app.post('/api/planificacion/orden', async (req, res) => {
    const {
        numero_pedido,
        op,
        producto_codigo,
        producto_nombre,
        cantidad_planificada,
        cliente,
        fecha_prometida,
        fecha_orden,
        ruta_tecnica,
        ad_workflow_id,
        m_production_id
    } = req.body;

    try {
        await validarCantidadDisponiblePedido({
            numero_pedido,
            producto_codigo,
            cantidad_planificada,
            op_excluir: op
        });

        const tieneMProductionId = await tablaTieneColumnaLocal('ordenes_planificacion', 'm_production_id');

        if (tieneMProductionId) {
            await db.run(`
                INSERT INTO ordenes_planificacion (
                    numero_pedido, op, producto_codigo, producto_nombre, cantidad_planificada, cliente,
                    fecha_prometida, fecha_orden, ruta_tecnica, ad_workflow_id, m_production_id, estado
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EN_PROCESO')
            `, [
                numero_pedido,
                op,
                producto_codigo,
                producto_nombre,
                cantidad_planificada,
                cliente,
                toMySQLDate(fecha_prometida),
                toMySQLDate(fecha_orden),
                ruta_tecnica,
                ad_workflow_id,
                m_production_id || null
            ]);
        } else {
            await db.run(`
                INSERT INTO ordenes_planificacion (
                    numero_pedido, op, producto_codigo, producto_nombre, cantidad_planificada, cliente,
                    fecha_prometida, fecha_orden, ruta_tecnica, ad_workflow_id, estado
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EN_PROCESO')
            `, [
                numero_pedido,
                op,
                producto_codigo,
                producto_nombre,
                cantidad_planificada,
                cliente,
                toMySQLDate(fecha_prometida),
                toMySQLDate(fecha_orden),
                ruta_tecnica,
                ad_workflow_id
            ]);
        }

        res.json({
            success: true,
            estado: 'EN_PROCESO',
            message: 'Plan maestro guardado en PMS como EN_PROCESO. Lirion queda en borrador.'
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});


// ==========================================
// SOLICITUD DE INSUMOS POR SUPERVISOR (CARRITO MULTI-OP)
// ==========================================
async function asegurarColumnasSolicitudInsumosSupervisor() {
    await asegurarTablasSolicitudInsumos();

    const alters = [
        `ALTER TABLE solicitudes_insumos ADD COLUMN supervisor_nombre VARCHAR(255) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN op_origen VARCHAR(60) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN area_origen VARCHAR(120) NULL`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN cantidad_sugerida NUMERIC NULL DEFAULT 0`,
        `ALTER TABLE solicitudes_insumos_detalle ADD COLUMN cantidad_aprobada NUMERIC NULL DEFAULT 0`
    ];

    for (const sql of alters) {
        try { await db.run(sql); } catch (_) { }
    }
}

async function obtenerStockTotalProductoLirion(productId) {
    const result = await poolIdempiere.query(`
        SELECT COALESCE(SUM(s.qtyonhand), 0) AS disponible
        FROM adempiere.m_storageonhand s
        JOIN adempiere.m_locator l
          ON l.m_locator_id = s.m_locator_id
         AND l.isactive = 'Y'
        WHERE s.m_product_id = $1
          AND l.m_warehouse_id = $2
          AND s.qtyonhand > 0
    `, [productId, WAREHOUSE_PRODUCCION_ID]);

    return numeroSeguro(result.rows?.[0]?.disponible, 0);
}

async function obtenerMejorStockProductoLirion(client, productId) {
    const result = await client.query(`
        SELECT
            s.m_locator_id,
            s.m_attributesetinstance_id,
            COALESCE(SUM(s.qtyonhand), 0) AS disponible
        FROM adempiere.m_storageonhand s
        JOIN adempiere.m_locator l ON l.m_locator_id = s.m_locator_id AND l.isactive = 'Y'
        WHERE s.m_product_id = $1
          AND l.m_warehouse_id = $2
          AND s.qtyonhand > 0
        GROUP BY s.m_locator_id, s.m_attributesetinstance_id
        ORDER BY COALESCE(SUM(s.qtyonhand), 0) DESC, s.m_locator_id ASC
        LIMIT 1
    `, [productId, WAREHOUSE_ORIGEN_INSUMOS_ID]);

    return result.rows?.[0] || null;
}

async function obtenerLocatorDestinoInsumosLirion(client) {
    const result = await client.query(`
        SELECT l.m_locator_id, l.value
        FROM adempiere.m_locator l
        JOIN adempiere.m_warehouse w
          ON w.m_warehouse_id = l.m_warehouse_id
         AND w.ad_client_id = 1000000
         AND w.isactive = 'Y'
        WHERE l.isactive = 'Y'
          AND l.ad_client_id = 1000000
          AND l.m_warehouse_id = $1
        ORDER BY
          CASE
            WHEN UPPER(COALESCE(l.value, '')) LIKE '%PROD%' THEN 0
            WHEN UPPER(COALESCE(l.value, '')) LIKE '%RECEP%' THEN 1
            ELSE 2
          END,
          l.value ASC,
          l.m_locator_id ASC
        LIMIT 1
    `, [WAREHOUSE_PRODUCCION_ID]);

    if (!result.rows.length) {
        throw new Error('No se encontró una ubicación destino activa y válida para M_WarehouseTo_ID=1000002.');
    }

    return Number(result.rows[0].m_locator_id);
}


async function obtenerLocatorOrigenFallbackInsumosLirion(client) {
    // Nunca usar el primer locator global de la tabla: en esta instalación pueden existir
    // locators de System/otro tenant (por ejemplo IDs bajos como 101...) y Lirion muestra
    // "Cross tenant PO reading request detected" al abrir la solicitud. Para una solicitud
    // de insumos sin stock, usamos una ubicación activa del MISMO tenant y de la bodega origen.
    const result = await client.query(`
        SELECT l.m_locator_id, l.value
        FROM adempiere.m_locator l
        JOIN adempiere.m_warehouse w
          ON w.m_warehouse_id = l.m_warehouse_id
         AND w.ad_client_id = 1000000
         AND w.isactive = 'Y'
        WHERE l.isactive = 'Y'
          AND l.ad_client_id = 1000000
          AND l.m_warehouse_id = $1
        ORDER BY
          CASE
            WHEN UPPER(COALESCE(l.value, '')) LIKE '%PROD%' THEN 0
            WHEN UPPER(COALESCE(l.value, '')) LIKE '%RECEP%' THEN 1
            ELSE 2
          END,
          l.value ASC,
          l.m_locator_id ASC
        LIMIT 1
    `, [WAREHOUSE_PRODUCCION_ID]);

    if (!result.rows.length) {
        throw new Error('No se encontró una ubicación origen válida en Bodega Producción (M_Warehouse_ID=1000002) para crear la solicitud de insumos.');
    }

    return Number(result.rows[0].m_locator_id);
}

function resumirMaterialesRutaOp(ruta) {
    const salida = [];
    for (const etapa of parseJsonArraySeguro(ruta, [])) {
        for (const mat of (etapa.materiales || [])) {
            const productId = Number(mat?.m_product_id);
            const cantidad = numeroSeguro(mat?.cantidad, 0);
            if (!productId || cantidad <= 0) continue;
            salida.push({
                op: null,
                area_origen: etapa.area || etapa.nombre_etapa || 'Sin etapa',
                m_product_id: productId,
                producto_codigo: mat.codigo || mat.producto_codigo || null,
                producto_nombre: mat.nombre || mat.producto_nombre || mat.nombre_visual || null,
                nombre_visual: mat.nombre_visual || mat.nombre || mat.producto_nombre || String(productId),
                cantidad_requerida: cantidad,
                c_uom_id: mat.c_uom_id || null,
                uom_nombre: mat.uom_nombre || null
            });
        }
    }
    return salida;
}

app.get('/api/supervisor/insumos/necesidades', async (req, res) => {
    try {
        await asegurarColumnasSolicitudInsumosSupervisor();

        const ordenes = await db.all(`
            SELECT
                op,
                numero_pedido,
                producto_codigo,
                producto_nombre,
                cantidad_planificada,
                NULL AS um,
                estado,
                ruta_tecnica,
                fecha_creacion
            FROM ordenes_planificacion
            WHERE UPPER(COALESCE(estado, '')) NOT IN ('FINALIZADO','RECHAZADO','RECHAZADA','ANULADO','ANULADA','CANCELADO','CANCELADA','PENDIENTE_APROBACION_PLANIFICACION')
            ORDER BY fecha_creacion ASC, id ASC
        `);

        const solicitudesActivas = await db.all(`
            SELECT
                COALESCE(d.op_origen, s.op) AS op_origen,
                COALESCE(d.area_origen, '') AS area_origen,
                d.m_product_id,
                SUM(COALESCE(NULLIF(d.cantidad_aprobada, 0), d.cantidad, 0)) AS cantidad_solicitada,
                GROUP_CONCAT(DISTINCT COALESCE(s.documentno, 'PMS') SEPARATOR ', ') AS documentos,
                MAX(s.estado_pms) AS estado_pms
            FROM solicitudes_insumos s
            JOIN solicitudes_insumos_detalle d ON d.solicitud_id = s.id
            WHERE UPPER(COALESCE(s.estado_pms, '')) NOT IN (
                'RECHAZADA_SUPERVISOR', 'RECHAZADO', 'RECHAZADA',
                'ANULADO', 'ANULADA', 'CANCELADO', 'CANCELADA', 'ERROR_LIRION'
            )
              AND COALESCE(d.op_origen, s.op) IS NOT NULL
            GROUP BY COALESCE(d.op_origen, s.op), COALESCE(d.area_origen, ''), d.m_product_id
        `).catch(() => []);

        const solicitadoPorOpProductoEtapa = new Map();
        for (const row of (solicitudesActivas || [])) {
            const key = `${String(row.op_origen || '').trim()}|${Number(row.m_product_id)}|${String(row.area_origen || '').trim()}`;
            solicitadoPorOpProductoEtapa.set(key, {
                cantidad: numeroSeguro(row.cantidad_solicitada, 0),
                documentos: row.documentos || '',
                estado_pms: row.estado_pms || ''
            });
        }

        const stockRestantePorProducto = new Map();
        const salida = [];
        let totalFaltantes = 0;
        let totalSolicitados = 0;

        for (const orden of (ordenes || [])) {
            const materiales = resumirMaterialesRutaOp(orden.ruta_tecnica).map(m => ({ ...m, op: orden.op }));
            const faltantes = [];
            const solicitados = [];

            for (const mat of materiales) {
                const productId = Number(mat.m_product_id);
                if (!stockRestantePorProducto.has(productId)) {
                    stockRestantePorProducto.set(productId, await obtenerStockTotalProductoLirion(productId));
                }

                const stockAntes = numeroSeguro(stockRestantePorProducto.get(productId), 0);
                const requerido = numeroSeguro(mat.cantidad_requerida, 0);
                const cubierto = Math.min(stockAntes, requerido);
                const faltanteBruto = Math.max(requerido - stockAntes, 0);
                stockRestantePorProducto.set(productId, Math.max(stockAntes - requerido, 0));

                if (faltanteBruto > 0) {
                    const key = `${String(orden.op || '').trim()}|${productId}|${String(mat.area_origen || '').trim()}`;
                    const solicitado = solicitadoPorOpProductoEtapa.get(key) || { cantidad: 0, documentos: '', estado_pms: '' };
                    const cantidadYaSolicitada = numeroSeguro(solicitado.cantidad, 0);
                    const faltanteNeto = Math.max(faltanteBruto - cantidadYaSolicitada, 0);

                    if (cantidadYaSolicitada > 0) {
                        totalSolicitados++;
                        solicitados.push({
                            ...mat,
                            cantidad_requerida: requerido,
                            stock_disponible: stockAntes,
                            cantidad_cubierta_stock: cubierto,
                            cantidad_faltante_original: Number(faltanteBruto.toFixed(3)),
                            cantidad_solicitada_en_proceso: Number(cantidadYaSolicitada.toFixed(3)),
                            cantidad_faltante_pendiente: Number(faltanteNeto.toFixed(3)),
                            documentos_solicitud: solicitado.documentos,
                            estado_solicitud: solicitado.estado_pms,
                            estado_stock: faltanteNeto > 0 ? 'FALTANTE_PARCIALMENTE_SOLICITADO' : 'INSUMOS_FALTANTES_SOLICITADOS'
                        });
                    }

                    if (faltanteNeto > 0) {
                        totalFaltantes++;
                        faltantes.push({
                            ...mat,
                            cantidad_requerida: requerido,
                            stock_disponible: stockAntes,
                            cantidad_cubierta_stock: cubierto,
                            cantidad_ya_solicitada: Number(cantidadYaSolicitada.toFixed(3)),
                            cantidad_faltante: Number(faltanteNeto.toFixed(3)),
                            estado_stock: cantidadYaSolicitada > 0
                                ? 'FALTANTE_PARCIALMENTE_SOLICITADO'
                                : (stockAntes <= 0 ? 'SIN_STOCK' : 'STOCK_INSUFICIENTE')
                        });
                    }
                }
            }

            salida.push({
                op: orden.op,
                numero_pedido: orden.numero_pedido,
                producto_codigo: orden.producto_codigo,
                producto_nombre: orden.producto_nombre,
                cantidad_planificada: numeroSeguro(orden.cantidad_planificada, 0),
                um: orden.um,
                estado: orden.estado,
                fecha_creacion: orden.fecha_creacion,
                total_materiales: materiales.length,
                total_faltantes: faltantes.length,
                total_solicitados: solicitados.length,
                faltantes,
                solicitados
            });
        }

        res.json({
            success: true,
            resumen: {
                total_ops: salida.length,
                ops_con_faltantes: salida.filter(o => o.total_faltantes > 0).length,
                ops_con_insumos_solicitados: salida.filter(o => o.total_solicitados > 0).length,
                total_faltantes: totalFaltantes,
                total_solicitados: totalSolicitados
            },
            ordenes: salida
        });
    } catch (err) {
        console.error('❌ Error calculando necesidades de insumos para supervisor:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/supervisor/insumos/solicitud', autenticarPMS, async (req, res) => {
    const { items, comentario, adempiere_user_id, supervisor_nombre } = req.body || {};

    const lineas = parseJsonArraySeguro(items, []).filter(item =>
        item?.op && Number(item?.m_product_id) > 0 && numeroSeguro(item?.cantidad_solicitada ?? item?.cantidad, 0) > 0
    );

    if (lineas.length === 0) {
        return res.status(400).json({ error: 'Debe agregar al carrito al menos un insumo con cantidad mayor a 0.' });
    }

    try {
        await asegurarColumnasSolicitudInsumosSupervisor();

        const supervisorAdUserId = await resolverCreadorLirionDesdeRequest(req, poolIdempiere)
            .catch(() => Number(adempiere_user_id));

        if (!Number.isFinite(Number(supervisorAdUserId)) || Number(supervisorAdUserId) <= 0 || Number(supervisorAdUserId) === 100) {
            throw new Error('No se pudo determinar el AD_User_ID real del supervisor en Lirion. Cierre sesión e ingrese nuevamente.');
        }

        const lirionToken = await obtenerTokenLirionParaCompletar(req);
        if (!lirionToken) {
            throw new Error('No hay token REST activo de Lirion para completar la solicitud de insumos. Cierre sesión e ingrese nuevamente.');
        }

        const ahora = new Date();
        const fechaAhora = toMySQLDate(ahora);
        const ops = [...new Set(lineas.map(i => String(i.op).trim()).filter(Boolean))];
        const opResumen = ops.join(', ').substring(0, 100);
        const detalleDescripcion = lineas
            .map(i => `${i.op}: ${i.nombre_visual || i.producto_nombre || i.m_product_id} x ${numeroSeguro(i.cantidad_solicitada ?? i.cantidad, 0)} ${i.uom_nombre || ''}`.trim())
            .join(' | ');

        const local = await insertarSolicitudInsumosCabecera({
            op: opResumen || 'MULTI_OP',
            proceso_id: null,
            operador_id: null,
            adempiere_user_id: Number(supervisorAdUserId),
            area_proceso: 'Solicitud supervisor multi-OP',
            estado_pms: 'PENDIENTE_ENVIO_LIRION',
            observacion: String(comentario || `Solicitud de insumos PMS Supervisor | OPs: ${opResumen} | ${detalleDescripcion}`).substring(0, 1000),
            fecha_solicitud: fechaAhora,
            pausa_inicio: fechaAhora,
            fecha_inicio_pausa: fechaAhora,
            supervisor_id: req.user?.id || req.user?.userId || null,
            supervisor_nombre: supervisor_nombre || req.user?.nombre || req.user?.username || null,
            created_at: fechaAhora,
            updated_at: fechaAhora
        });

        let solicitudId = local?.lastID || local?.insertId || null;
        if (!solicitudId) {
            const solicitudLocal = await db.get(`SELECT id FROM solicitudes_insumos ORDER BY id DESC LIMIT 1`);
            solicitudId = solicitudLocal?.id || null;
        }
        if (!solicitudId) throw new Error('No se pudo obtener el ID local de la solicitud de insumos.');

        for (const item of lineas) {
            await insertarRegistroFlexible('solicitudes_insumos_detalle', {
                solicitud_id: solicitudId,
                op_origen: item.op,
                area_origen: item.area_origen || item.area_proceso || null,
                m_product_id: Number(item.m_product_id),
                producto_codigo: item.producto_codigo || item.codigo || null,
                producto_nombre: item.producto_nombre || item.nombre || null,
                nombre_visual: item.nombre_visual || item.producto_nombre || item.nombre || String(item.m_product_id),
                cantidad_teorica: numeroSeguro(item.cantidad_requerida ?? item.cantidad_teorica, 0),
                cantidad_sugerida: numeroSeguro(item.cantidad_faltante ?? item.cantidad_sugerida, 0),
                cantidad_aprobada: numeroSeguro(item.cantidad_solicitada ?? item.cantidad, 0),
                cantidad: numeroSeguro(item.cantidad_solicitada ?? item.cantidad, 0),
                stock_disponible: numeroSeguro(item.stock_disponible, 0),
                estado_stock: item.estado_stock || null,
                c_uom_id: item.c_uom_id || null,
                uom_nombre: item.uom_nombre || null,
                m_attributesetinstance_id: item.m_attributesetinstance_id ?? 0,
                created_at: fechaAhora
            });
        }

        const solicitud = await db.get(`SELECT * FROM solicitudes_insumos WHERE id = ? LIMIT 1`, [solicitudId]);
        let detalles = await db.all(`SELECT * FROM solicitudes_insumos_detalle WHERE solicitud_id = ? ORDER BY id ASC`, [solicitudId]);

        // Compatibilidad: en algunos ambientes la tabla local existe desde versiones anteriores
        // y puede no devolver cantidad_aprobada/cantidad como se espera. Para evitar que el
        // backend descarte líneas válidas del carrito, reforzamos cada detalle con el item
        // original que envió el supervisor.
        detalles = (detalles || []).map((d) => {
            const itemOriginal = lineas.find((item) =>
                Number(item.m_product_id) === Number(d.m_product_id) &&
                String(item.op || '').trim() === String(d.op_origen || item.op || '').trim() &&
                String(item.area_origen || item.area_proceso || '').trim() === String(d.area_origen || '').trim()
            ) || lineas.find((item) => Number(item.m_product_id) === Number(d.m_product_id));

            const cantidadOriginal = numeroSeguro(
                itemOriginal?.cantidad_solicitada ??
                itemOriginal?.cantidad_aprobada ??
                itemOriginal?.cantidad ??
                itemOriginal?.cantidad_faltante,
                0
            );

            const cantidadDetalle = numeroSeguro(
                d.cantidad_aprobada ??
                d.cantidad_solicitada ??
                d.cantidad ??
                d.cantidad_sugerida,
                0
            );

            const cantidadFinal = cantidadDetalle > 0 ? cantidadDetalle : cantidadOriginal;

            return {
                ...d,
                op_origen: d.op_origen || itemOriginal?.op || null,
                area_origen: d.area_origen || itemOriginal?.area_origen || itemOriginal?.area_proceso || null,
                cantidad_aprobada: cantidadFinal,
                cantidad: cantidadFinal,
                cantidad_sugerida: numeroSeguro(d.cantidad_sugerida ?? itemOriginal?.cantidad_faltante, cantidadFinal),
                producto_codigo: d.producto_codigo || itemOriginal?.producto_codigo || itemOriginal?.codigo || null,
                producto_nombre: d.producto_nombre || itemOriginal?.producto_nombre || itemOriginal?.nombre || null,
                nombre_visual: d.nombre_visual || itemOriginal?.nombre_visual || itemOriginal?.producto_nombre || itemOriginal?.nombre || String(d.m_product_id),
                c_uom_id: d.c_uom_id || itemOriginal?.c_uom_id || null,
                uom_nombre: d.uom_nombre || itemOriginal?.uom_nombre || null
            };
        });

        const client = await poolIdempiere.connect();
        let destinoLocator = null;
        try {
            destinoLocator = await obtenerLocatorDestinoInsumosLirion(client);

            const origenFallback = await obtenerLocatorOrigenFallbackInsumosLirion(client);

            for (const d of detalles) {
                const mejorStock = await obtenerMejorStockProductoLirion(client, Number(d.m_product_id));

                // Si el producto está en stock 0, igual se debe poder generar la solicitud.
                // M_MovementLine exige m_locator_id, por eso usamos una ubicación origen activa de respaldo.
                d.m_locator_id = mejorStock?.m_locator_id ? Number(mejorStock.m_locator_id) : origenFallback;
                d.m_locatorto_id = destinoLocator;
                d.m_attributesetinstance_id = mejorStock?.m_attributesetinstance_id !== undefined && mejorStock?.m_attributesetinstance_id !== null
                    ? Number(mejorStock.m_attributesetinstance_id || 0)
                    : 0;
            }
        } finally {
            client.release();
        }

        const materialesAprobados = detalles.map(d => ({
            detalle_id: d.id,
            m_product_id: Number(d.m_product_id),
            cantidad_aprobada: numeroSeguro(
                d.cantidad_aprobada ??
                d.cantidad_solicitada ??
                d.cantidad ??
                d.cantidad_sugerida,
                0
            ),
            cantidad_solicitada: numeroSeguro(
                d.cantidad_aprobada ??
                d.cantidad_solicitada ??
                d.cantidad ??
                d.cantidad_sugerida,
                0
            ),
            locator_origen_id: Number(d.m_locator_id),
            locator_destino_id: Number(d.m_locatorto_id),
            m_attributesetinstance_id: Number(d.m_attributesetinstance_id || 0)
        }));

        const lineasInvalidas = materialesAprobados.filter(m =>
            !Number.isFinite(Number(m.m_product_id)) ||
            Number(m.m_product_id) <= 0 ||
            numeroSeguro(m.cantidad_aprobada, 0) <= 0
        );

        if (lineasInvalidas.length > 0) {
            console.warn('⚠️ Líneas de carrito ignoradas por datos incompletos:', lineasInvalidas);
        }

        const creado = await crearMovimientoInsumosEnLirionDesdeSolicitud({
            solicitud,
            detalles,
            materialesAprobados,
            supervisorAdUserId: Number(supervisorAdUserId),
            lirionToken
        });

        for (const linea of creado.lineasCreadas) {
            await db.run(`
                UPDATE solicitudes_insumos_detalle
                SET m_movementline_id = ?, m_locator_id = ?, m_locatorto_id = ?, m_attributesetinstance_id = ?, c_uom_id = ?, uom_nombre = ?, line = ?
                WHERE id = ?
            `, [
                linea.m_movementline_id,
                linea.m_locator_id,
                linea.m_locatorto_id,
                linea.m_attributesetinstance_id,
                linea.c_uom_id,
                linea.uom_nombre,
                linea.line,
                linea.detalle_id
            ]);
        }

        const preparadaLirion = !!creado.preparada;

        await db.run(`
            UPDATE solicitudes_insumos
            SET estado_pms = ?,
                fecha_respuesta_supervisor = ?,
                supervisor_id = ?,
                comentario_supervisor = ?,
                m_movement_id = ?,
                documentno = ?,
                docstatus = ?,
                docaction = ?,
                respuesta_lirion = ?,
                updated_at = ?
            WHERE id = ?
        `, [
            preparadaLirion ? 'COMPLETADO_LIRION' : 'BORRADOR_LIRION_NO_COMPLETADO',
            fechaAhora,
            req.user?.id || req.user?.userId || null,
            comentario || null,
            creado.mMovementId,
            creado.documentNo,
            creado.estadoFinal?.docstatus || null,
            creado.estadoFinal?.docaction || null,
            JSON.stringify({ proceso: creado.respuestaProceso, estado: creado.estadoFinal, errorPreparacion: creado.errorPreparacion || null }).substring(0, 5000),
            fechaAhora,
            solicitudId
        ]);

        if (!preparadaLirion) {
            return res.status(409).json({
                success: false,
                error: creado.errorPreparacion || `Lirion creó la solicitud ${creado.documentNo}, pero no la completó.`,
                solicitud_id: solicitudId,
                m_movement_id: creado.mMovementId,
                documentno: creado.documentNo,
                docstatus: creado.estadoFinal?.docstatus,
                estado_lirion: creado.estadoFinal,
                lineas: creado.lineasCreadas.length
            });
        }

        res.json({
            success: true,
            message: `Solicitud de insumos creada y completada en Lirion. Documento ${creado.documentNo}.`,
            solicitud_id: solicitudId,
            m_movement_id: creado.mMovementId,
            documentno: creado.documentNo,
            docstatus: creado.estadoFinal?.docstatus,
            lineas: creado.lineasCreadas.length
        });
    } catch (err) {
        console.error('❌ Error creando solicitud de insumos desde supervisor:', err.message);
        res.status(500).json({ error: err.message });
    }
});


app.get('/api/planificacion/pendientes', async (req, res) => {
    try {
        const ordenes = await db.all(`
            SELECT op.*, 
            (SELECT COUNT(*) FROM procesos p WHERE p.op = op.op AND p.estado = 'EN_PROCESO') as en_uso,
            (SELECT COUNT(*) FROM procesos p WHERE p.op = op.op) as total_pasos_registrados
            FROM ordenes_planificacion op WHERE op.estado != 'FINALIZADO'
        `);
        res.json(ordenes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.get('/api/planificacion/pendientes-aprobacion', async (req, res) => {
    try {
        await asegurarTablaNotificaciones();

        const ordenes = await db.all(`
            SELECT 
                op.*,
                (SELECT COUNT(*) FROM procesos p WHERE p.op = op.op AND p.estado = 'EN_PROCESO') as procesos_activos,
                (SELECT COUNT(*) FROM procesos p WHERE p.op = op.op AND p.estado = 'FINALIZADO') as procesos_finalizados,
                (SELECT COUNT(*) FROM procesos p WHERE p.op = op.op) as total_pasos_registrados,
                COALESCE((
                    SELECT p.cantidad_contada
                    FROM procesos p
                    WHERE p.op = op.op
                      AND p.estado = 'FINALIZADO'
                      AND p.cantidad_contada IS NOT NULL
                    ORDER BY p.fecha_salida DESC, p.id DESC
                    LIMIT 1
                ), 0) as produccion_total_real,
                (SELECT COALESCE(SUM(p.cantidad_merma), 0) FROM procesos p WHERE p.op = op.op) as merma_total_real,
                (SELECT n.fecha_creacion FROM notificaciones n WHERE n.op = op.op AND n.rol_destino = 'planificacion' ORDER BY n.fecha_creacion DESC LIMIT 1) as fecha_notificacion
            FROM ordenes_planificacion op
            WHERE op.estado = 'PENDIENTE_APROBACION_PLANIFICACION'
            ORDER BY COALESCE(fecha_notificacion, op.fecha_creacion) DESC
        `);

        res.json(ordenes || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/planificacion/completar-op/:op', autenticarPMS, async (req, res) => {
    const { op } = req.params;
    const { adempiere_user_id, usuario_nombre } = req.body || {};

    try {
        const plan = await db.get(`SELECT * FROM ordenes_planificacion WHERE op = ? LIMIT 1`, [op]);
        if (!plan) {
            return res.status(404).json({ success: false, error: `No se encontró la OP ${op} en el PMS.` });
        }

        const estadoActual = String(plan.estado || '').toUpperCase();
        if (estadoActual !== 'PENDIENTE_APROBACION_PLANIFICACION') {
            return res.status(400).json({
                success: false,
                error: `La OP ${op} no está pendiente de aprobación de Planificación. Estado actual: ${plan.estado}.`
            });
        }

        let plannerId = null;
        try {
            plannerId = await resolverCreadorLirionDesdeRequest(req, poolIdempiere);
        } catch (e) {
            plannerId = Number(adempiere_user_id);
        }

        if (!Number.isFinite(plannerId) || plannerId <= 0 || plannerId === 100) {
            throw new Error('No se pudo determinar el AD_User_ID real de Planificación en Lirion. Cierre sesión y vuelva a ingresar.');
        }

        let mProductionId = Number(plan.m_production_id || 0);

        if (!mProductionId) {
            const prodLocalizada = await poolIdempiere.query(`
                SELECT m_production_id
                FROM adempiere.m_production
                WHERE regexp_replace(UPPER(TRIM(documentno)), '[^A-Z0-9]', '', 'g') =
                      regexp_replace(UPPER(TRIM($1)), '[^A-Z0-9]', '', 'g')
                  AND isactive = 'Y'
                ORDER BY created DESC
                LIMIT 1
            `, [op]);

            if (!prodLocalizada.rows.length) {
                throw new Error(`No se encontró la OP ${op} en Lirion para completar.`);
            }

            mProductionId = Number(prodLocalizada.rows[0].m_production_id);
        }

        const lirionToken = await obtenerTokenLirionParaCompletar(req);
        if (!lirionToken) {
            throw new Error('No hay token REST activo de Lirion para completar la OP. Cierre sesión e ingrese nuevamente.');
        }

        // Dejamos el encabezado marcado con el usuario de planificación antes de ejecutar DocAction.
        await poolIdempiere.query(`
            UPDATE adempiere.m_production
            SET updated = NOW(), updatedby = $1
            WHERE m_production_id = $2
        `, [plannerId, mProductionId]);

        await reintentarCompletarProduccionCorrigiendoFechaSiPeriodoCerrado({
            mProductionId,
            lirionToken,
            plannerId,
            op
        });
        const estadoLirion = await verificarProduccionProcesada(mProductionId);

        if (!estadoLirion.completada) {
            throw new Error(`Lirion no dejó la OP ${op} completada. Estado=${estadoLirion.docstatus}, processed=${estadoLirion.processed}.`);
        }

        await poolIdempiere.query(`
            UPDATE adempiere.m_production
            SET updated = NOW(), updatedby = $1
            WHERE m_production_id = $2
        `, [plannerId, mProductionId]);

        await db.run(`UPDATE ordenes_planificacion SET estado = 'FINALIZADO' WHERE op = ?`, [op]);

        await db.run(
            `INSERT INTO trazabilidad 
             (op, usuario, rol, fecha, tipo_cambio, contexto, valor_anterior, valor_nuevo) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                op,
                usuario_nombre || req.user?.nombre || 'Planificación',
                'planificacion',
                toMySQLDate(new Date()),
                'Cierre Final',
                'Planificación completó documento en Lirion',
                'PENDIENTE_APROBACION_PLANIFICACION',
                'FINALIZADO'
            ]
        );

        await marcarNotificacionesPlanificacionLeidas(op, req.user?.id || null);

        res.json({
            success: true,
            op,
            m_production_id: mProductionId,
            docstatus: estadoLirion.docstatus,
            processed: estadoLirion.processed,
            estado_pms: 'FINALIZADO',
            message: `OP ${op} completada correctamente en Lirion y PMS.`
        });
    } catch (err) {
        console.error('❌ Error completando OP desde Planificación:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/planificacion/materiales-op/:op', async (req, res) => {
    try {
        const row = await db.get("SELECT ruta_tecnica FROM ordenes_planificacion WHERE op = ?", [req.params.op]);
        if (row && row.ruta_tecnica) { res.json(JSON.parse(row.ruta_tecnica)); } else { res.status(404).json({ error: "No se encontró planificación" }); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/planificacion/orden/:op/cerrar', async (req, res) => {
    try {
        await db.run("UPDATE ordenes_planificacion SET estado = 'FINALIZADO' WHERE op = ?", [req.params.op]);
        res.json({ message: 'Orden cerrada definitivamente' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/planificacion/todas', async (req, res) => {
    try {
        const result = await db.all("SELECT * FROM ordenes_planificacion");
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CARTA GANTT - PEDIDOS LIRION + OP LOCALES
// ==========================================
function fechaISOPlanificacion(fecha) {
    if (!fecha) return null;

    if (typeof fecha === 'string') {
        const limpia = fecha.trim();
        if (!limpia) return null;
        if (/^\d{4}-\d{2}-\d{2}/.test(limpia)) return limpia.substring(0, 10);
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(limpia)) {
            const [d, m, y] = limpia.split('/');
            return `${y}-${m}-${d}`;
        }
    }

    const d = new Date(fecha);
    if (isNaN(d.getTime())) return null;

    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sumarDiasPlanificacion(fecha, dias) {
    const d = new Date(fecha);
    d.setDate(d.getDate() + dias);
    return d;
}

function normalizarTextoClave(valor) {
    return String(valor || '').trim().toUpperCase();
}

function calcularEstadoGantt({ tieneOp, estadoLocal, enProceso, totalProcesos, fechaPrometida }) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const promesa = fechaPrometida ? new Date(fechaPrometida) : null;
    if (promesa && !isNaN(promesa.getTime())) promesa.setHours(0, 0, 0, 0);

    const estado = normalizarTextoClave(estadoLocal);
    const finalizado = estado === 'FINALIZADO' || estado === 'LISTO EN BODEGA' || estado === 'COMPLETADO';
    const atrasado = !!promesa && promesa < hoy && !finalizado;

    if (!tieneOp) {
        return {
            estado_gantt: atrasado ? 'ATRASADO' : 'SIN_OP',
            estado_label: atrasado ? 'Atrasado sin OP' : 'Sin OP',
            atrasado
        };
    }

    if (finalizado) {
        return { estado_gantt: 'FABRICADO', estado_label: 'Fabricado', atrasado: false };
    }

    if (atrasado) {
        return { estado_gantt: 'ATRASADO', estado_label: 'Atrasado', atrasado: true };
    }

    if (Number(enProceso || 0) > 0 || estado === 'EN_PROCESO') {
        return { estado_gantt: 'EN_PROCESO', estado_label: 'En proceso', atrasado: false };
    }

    if (Number(totalProcesos || 0) > 0 || estado === 'PENDIENTE_CALIDAD') {
        return { estado_gantt: 'EN_PROCESO', estado_label: estado === 'PENDIENTE_CALIDAD' ? 'Pend. calidad' : 'En proceso', atrasado: false };
    }

    return { estado_gantt: 'PENDIENTE', estado_label: 'Planificado', atrasado: false };
}

app.get('/api/planificacion/gantt', async (req, res) => {
    const hoy = new Date();
    const desdeParam = req.query.desde ? new Date(String(req.query.desde)) : sumarDiasPlanificacion(hoy, -5);
    const hastaParam = req.query.hasta ? new Date(String(req.query.hasta)) : sumarDiasPlanificacion(hoy, 90);

    const desde = isNaN(desdeParam.getTime()) ? sumarDiasPlanificacion(hoy, -5) : desdeParam;
    const hasta = isNaN(hastaParam.getTime()) ? sumarDiasPlanificacion(hoy, 90) : hastaParam;
    const desdeISO = fechaISOPlanificacion(desde);
    const hastaISO = fechaISOPlanificacion(hasta);

    try {
        const pedidosLirionResult = await poolIdempiere.query(`
            SELECT
                o.c_order_id,
                o.documentno AS numero_pedido,
                o.dateordered::date AS fecha_orden,
                o.datepromised::date AS fecha_prometida,
                bp.name AS cliente,
                COUNT(ol.c_orderline_id) AS lineas,
                COALESCE(SUM(ol.qtyentered), 0) AS cantidad_total,
                STRING_AGG(DISTINCT (p.value || ' - ' || p.name), ' | ') AS productos
            FROM adempiere.c_order o
            JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = o.c_bpartner_id
            JOIN adempiere.c_orderline ol ON ol.c_order_id = o.c_order_id AND ol.isactive = 'Y'
            JOIN adempiere.m_product p ON p.m_product_id = ol.m_product_id
            WHERE o.isactive = 'Y'
              AND o.issotrx = 'Y'
              AND o.docstatus IN ('CO', 'CL')
              AND o.c_doctypetarget_id = 1000493
              AND (
                    o.datepromised::date BETWEEN $1::date AND $2::date
                 OR o.dateordered::date BETWEEN $1::date AND $2::date
              )
            GROUP BY o.c_order_id, o.documentno, o.dateordered, o.datepromised, bp.name
            ORDER BY o.datepromised ASC NULLS LAST, o.dateordered ASC NULLS LAST, o.documentno ASC
        `, [desdeISO, hastaISO]);

        const ordenesLocales = await db.all(`
            SELECT
                op.*,
                (SELECT COUNT(*) FROM procesos p WHERE p.op = op.op AND p.estado = 'EN_PROCESO') AS en_proceso,
                (SELECT COUNT(*) FROM procesos p WHERE p.op = op.op) AS total_procesos,
                (SELECT MIN(p.fecha_entrada) FROM procesos p WHERE p.op = op.op) AS fecha_inicio_real,
                (SELECT MAX(COALESCE(p.fecha_salida, p.fecha_entrada)) FROM procesos p WHERE p.op = op.op) AS fecha_fin_real
            FROM ordenes_planificacion op
        `);

        const pedidosPorNumero = new Map();
        for (const pedido of pedidosLirionResult.rows || []) {
            pedidosPorNumero.set(normalizarTextoClave(pedido.numero_pedido), pedido);
        }

        const items = [];
        const pedidosConOp = new Set();

        for (const op of ordenesLocales || []) {
            const pedidoKey = normalizarTextoClave(op.numero_pedido);
            const pedidoLirion = pedidosPorNumero.get(pedidoKey) || null;
            if (pedidoKey) pedidosConOp.add(pedidoKey);

            const fechaOrden = fechaISOPlanificacion(op.fecha_orden || pedidoLirion?.fecha_orden || op.fecha_creacion);
            const fechaPrometida = fechaISOPlanificacion(op.fecha_prometida || pedidoLirion?.fecha_prometida || op.fecha_creacion);
            const estado = calcularEstadoGantt({
                tieneOp: true,
                estadoLocal: op.estado,
                enProceso: op.en_proceso,
                totalProcesos: op.total_procesos,
                fechaPrometida
            });

            items.push({
                origen: 'LOCAL_OP',
                numero_pedido: op.numero_pedido || pedidoLirion?.numero_pedido || '',
                op: op.op || '',
                cliente: op.cliente || pedidoLirion?.cliente || '',
                producto_codigo: op.producto_codigo || '',
                producto_nombre: op.producto_nombre || pedidoLirion?.productos || '',
                productos: pedidoLirion?.productos || op.producto_nombre || '',
                cantidad_planificada: Number(op.cantidad_planificada || pedidoLirion?.cantidad_total || 0),
                fecha_orden: fechaOrden,
                fecha_prometida: fechaPrometida,
                fecha_planificacion: fechaISOPlanificacion(op.fecha_creacion),
                fecha_inicio_real: fechaISOPlanificacion(op.fecha_inicio_real),
                fecha_fin_real: fechaISOPlanificacion(op.fecha_fin_real),
                estado_local: op.estado || '',
                en_proceso: Number(op.en_proceso || 0),
                total_procesos: Number(op.total_procesos || 0),
                ...estado
            });
        }

        for (const pedido of pedidosLirionResult.rows || []) {
            const pedidoKey = normalizarTextoClave(pedido.numero_pedido);
            if (pedidosConOp.has(pedidoKey)) continue;

            const fechaOrden = fechaISOPlanificacion(pedido.fecha_orden);
            const fechaPrometida = fechaISOPlanificacion(pedido.fecha_prometida);
            const estado = calcularEstadoGantt({
                tieneOp: false,
                estadoLocal: '',
                enProceso: 0,
                totalProcesos: 0,
                fechaPrometida
            });

            items.push({
                origen: 'LIRION_SIN_OP',
                numero_pedido: pedido.numero_pedido || '',
                op: '',
                cliente: pedido.cliente || '',
                producto_codigo: '',
                producto_nombre: pedido.productos || '',
                productos: pedido.productos || '',
                cantidad_planificada: Number(pedido.cantidad_total || 0),
                fecha_orden: fechaOrden,
                fecha_prometida: fechaPrometida,
                fecha_planificacion: null,
                fecha_inicio_real: null,
                fecha_fin_real: null,
                estado_local: 'SIN_OP',
                en_proceso: 0,
                total_procesos: 0,
                ...estado
            });
        }

        const dentroDeRango = (item) => {
            const f1 = item.fecha_prometida ? new Date(item.fecha_prometida) : null;
            const f2 = item.fecha_orden ? new Date(item.fecha_orden) : null;
            const min = new Date(desdeISO);
            const max = new Date(hastaISO);

            // No mostrar pedidos vencidos muy antiguos en la carta Gantt.
            // La vista debe servir para la gestión diaria: máximo 5 días de atraso visible.
            if (item.atrasado && f1 && !isNaN(f1.getTime())) {
                const hoyBase = new Date();
                hoyBase.setHours(0, 0, 0, 0);
                f1.setHours(0, 0, 0, 0);
                const diasAtraso = Math.round((hoyBase.getTime() - f1.getTime()) / 86400000);
                if (diasAtraso > 5) return false;
            }

            const ok1 = f1 && !isNaN(f1.getTime()) && f1 >= min && f1 <= max;
            const ok2 = f2 && !isNaN(f2.getTime()) && f2 >= min && f2 <= max;
            return ok1 || ok2;
        };

        const itemsFiltrados = items
            .filter(dentroDeRango)
            .sort((a, b) => {
                const fechaA = new Date(a.fecha_prometida || a.fecha_orden || '2999-12-31').getTime();
                const fechaB = new Date(b.fecha_prometida || b.fecha_orden || '2999-12-31').getTime();
                if (fechaA !== fechaB) return fechaA - fechaB;
                return String(a.numero_pedido || a.op || '').localeCompare(String(b.numero_pedido || b.op || ''));
            });

        const resumen = {
            total: itemsFiltrados.length,
            sin_op: itemsFiltrados.filter(i => i.estado_gantt === 'SIN_OP').length,
            pendiente: itemsFiltrados.filter(i => i.estado_gantt === 'PENDIENTE').length,
            en_proceso: itemsFiltrados.filter(i => i.estado_gantt === 'EN_PROCESO').length,
            fabricado: itemsFiltrados.filter(i => i.estado_gantt === 'FABRICADO').length,
            atrasado: itemsFiltrados.filter(i => i.atrasado).length
        };

        res.json({
            desde: desdeISO,
            hasta: hastaISO,
            resumen,
            items: itemsFiltrados
        });
    } catch (err) {
        console.error('❌ Error construyendo carta Gantt:', err.message);
        res.status(500).json({
            error: 'No se pudo construir la carta Gantt.',
            detalle: err.message
        });
    }
});


// ==========================================
// F. CUADERNO - PLANNER MANUAL DE PLANIFICACIÓN
// ==========================================
async function asegurarTablaCuadernoProduccion() {
    // Tabla nueva: el cuaderno deja de ser una vista masiva de pedidos Lirion.
    // Ahora es una planilla manual donde planificación agrega líneas futuras.
    await db.run(`
        CREATE TABLE IF NOT EXISTS cuaderno_planificacion (
            id INT AUTO_INCREMENT PRIMARY KEY,
            cliente TEXT NULL,
            materia_prima TEXT NULL,
            producto TEXT NULL,
            codigo_pt TEXT NULL,
            cantidad_pedida_mt DECIMAL(18,3) NULL,
            cantidad_pedida_un DECIMAL(18,3) NULL,
            pedido TEXT NULL,
            oc TEXT NULL,
            cantidad_solicitada_mt DECIMAL(18,3) NULL,
            cantidad_plan_mt DECIMAL(18,3) NULL,
            largo_corte VARCHAR(50) NULL,
            factor VARCHAR(50) NULL,
            fecha VARCHAR(20) NULL,
            op_asignada VARCHAR(100) NULL,
            impreso VARCHAR(20) NULL DEFAULT 'FALSO',
            nota TEXT NULL,
            created_by TEXT NULL,
            created_at DATETIME NULL,
            updated_by TEXT NULL,
            updated_at DATETIME NULL
        )
    `);

    // Se mantiene la tabla anterior por compatibilidad; ya no alimenta automáticamente la grilla.
    await db.run(`
        CREATE TABLE IF NOT EXISTS cuaderno_produccion (
            op VARCHAR(100) PRIMARY KEY,
            materia_prima TEXT NULL,
            producto TEXT NULL,
            cantidad_mt DECIMAL(18,3) NULL,
            codigo TEXT NULL,
            salida_mt_un DECIMAL(18,3) NULL,
            maquinas TEXT NULL,
            cliente TEXT NULL,
            pedido TEXT NULL,
            estado TEXT NULL,
            fecha_planificacion VARCHAR(20) NULL,
            largo VARCHAR(50) NULL,
            factor VARCHAR(50) NULL,
            fecha_cierre_op VARCHAR(20) NULL,
            observacion TEXT NULL,
            updated_by TEXT NULL,
            updated_at DATETIME NULL
        )
    `);
}

function formatearFechaCuaderno(fecha) {
    if (!fecha) return '';

    if (typeof fecha === 'string') {
        const limpia = fecha.trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(limpia)) return limpia;
        if (/^\d{4}-\d{2}-\d{2}/.test(limpia)) {
            const [y, m, d] = limpia.substring(0, 10).split('-');
            return `${d}/${m}/${y}`;
        }
    }

    const d = new Date(fecha);
    if (isNaN(d.getTime())) return '';

    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function parseFechaCuaderno(fecha) {
    if (!fecha) return null;
    const texto = String(fecha).trim();

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(texto)) {
        const [dd, mm, yyyy] = texto.split('/').map(Number);
        const d = new Date(yyyy, mm - 1, dd);
        return isNaN(d.getTime()) ? null : d;
    }

    if (/^\d{4}-\d{2}-\d{2}/.test(texto)) {
        const [yyyy, mm, dd] = texto.substring(0, 10).split('-').map(Number);
        const d = new Date(yyyy, mm - 1, dd);
        return isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(texto);
    return isNaN(d.getTime()) ? null : d;
}

function normalizarNumeroCuaderno(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;

    let limpio = String(valor).trim();
    if (!limpio) return null;

    // Soporta formatos tipo Excel chileno: 6.000,50 => 6000.50
    if (limpio.includes(',') && limpio.includes('.')) {
        limpio = limpio.replace(/\./g, '').replace(',', '.');
    } else if (limpio.includes(',')) {
        limpio = limpio.replace(',', '.');
    }

    const n = Number(limpio);
    return Number.isFinite(n) ? n : null;
}

function extraerIdCuaderno(rowKey) {
    const texto = String(rowKey || '').trim();
    if (!texto) return null;

    const match = texto.match(/^(?:plan_)?(\d+)$/i);
    if (!match) return null;

    const id = Number(match[1]);
    return Number.isFinite(id) && id > 0 ? id : null;
}

function esEstadoFinalCuaderno(estado) {
    const e = String(estado || '').trim().toUpperCase();
    return [
        'FINALIZADO',
        'COMPLETADO',
        'COMPLETA',
        'COMPLETO',
        'CERRADO',
        'CERRADA',
        'LISTO EN BODEGA'
    ].includes(e);
}

function calcularDiasCuaderno(fecha) {
    const d = parseFechaCuaderno(fecha);
    if (!d) return '';

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    return Math.ceil((d.getTime() - hoy.getTime()) / 86400000);
}

function calcularSalidaCuaderno(cantidadPlanMt, factor) {
    const plan = normalizarNumeroCuaderno(cantidadPlanMt);
    const f = normalizarNumeroCuaderno(factor);
    if (plan === null) return null;
    return plan * (f === null ? 1 : f);
}

function construirPayloadFilaCuaderno(body = {}) {
    return {
        cliente: body.cliente ?? null,
        materia_prima: body.materia_prima ?? null,
        producto: body.producto ?? null,
        codigo_pt: body.codigo_pt ?? body.codigo ?? null,
        cantidad_pedida_mt: normalizarNumeroCuaderno(body.cantidad_pedida_mt),
        cantidad_pedida_un: normalizarNumeroCuaderno(body.cantidad_pedida_un),
        pedido: body.pedido ?? null,
        oc: body.oc ?? 'S/N',
        cantidad_solicitada_mt: normalizarNumeroCuaderno(body.cantidad_solicitada_mt),
        cantidad_plan_mt: normalizarNumeroCuaderno(body.cantidad_plan_mt),
        largo_corte: body.largo_corte ?? body.largo ?? null,
        factor: body.factor ?? null,
        fecha: body.fecha ?? body.fecha_planificacion ?? null,
        op_asignada: body.op_asignada ?? body.op ?? null,
        impreso: body.impreso ?? 'FALSO',
        nota: body.nota ?? body.observacion ?? null,
        usuario: body.usuario || 'SISTEMA'
    };
}

async function obtenerEstadoLirionPorOps(ops) {
    const limpias = [...new Set((ops || []).map(op => String(op || '').trim()).filter(Boolean))];
    const mapa = new Map();

    if (limpias.length === 0) return mapa;

    try {
        const result = await poolIdempiere.query(`
            SELECT documentno, docstatus, processed
            FROM adempiere.m_production
            WHERE documentno = ANY($1::text[])
              AND isactive = 'Y'
            ORDER BY updated DESC, created DESC
        `, [limpias]);

        for (const row of result.rows || []) {
            const key = String(row.documentno || '').trim();
            if (!mapa.has(key)) mapa.set(key, row);
        }
    } catch (err) {
        console.warn('⚠️ No se pudo cruzar estado Lirion para F. Cuaderno:', err.message);
    }

    return mapa;
}

async function filaCuadernoEstaCerrada(opAsignada) {
    const op = String(opAsignada || '').trim();
    if (!op) return false;

    const local = await db.get(`
        SELECT estado
        FROM ordenes_planificacion
        WHERE op = ?
        LIMIT 1
    `, [op]);

    if (esEstadoFinalCuaderno(local?.estado)) return true;

    const lirion = await obtenerEstadoLirionPorOps([op]);
    const estadoLirion = lirion.get(op);
    return String(estadoLirion?.docstatus || '').toUpperCase() === 'CO'
        && String(estadoLirion?.processed || '').toUpperCase() === 'Y';
}

app.get('/api/planificacion/cuaderno', async (req, res) => {
    try {
        await asegurarTablaCuadernoProduccion();

        // No se consulta C_Order completo ni se trae todo Lirion.
        // Esta pantalla es un planner: devuelve solamente lo que planificación ingresó aquí.
        const filasBase = await db.all(`
            SELECT *
            FROM cuaderno_planificacion
            ORDER BY
                CASE WHEN fecha IS NULL OR fecha = '' THEN 1 ELSE 0 END ASC,
                fecha ASC,
                id DESC
        `);

        if (!filasBase || filasBase.length === 0) {
            return res.json([]);
        }

        const ops = [...new Set((filasBase || [])
            .map(f => String(f.op_asignada || '').trim())
            .filter(Boolean))];

        let ordenesPms = [];
        let procesos = [];

        if (ops.length > 0) {
            const placeholders = ops.map(() => '?').join(',');

            ordenesPms = await db.all(`
                SELECT op, numero_pedido, producto_codigo, producto_nombre, cantidad_planificada, estado
                FROM ordenes_planificacion
                WHERE op IN (${placeholders})
            `, ops);

            procesos = await db.all(`
                SELECT op, cantidad_contada, fecha_salida, fecha_entrada, id, estado
                FROM procesos
                WHERE op IN (${placeholders})
                  AND cantidad_contada IS NOT NULL
                ORDER BY op ASC, fecha_salida DESC, fecha_entrada DESC, id DESC
            `, ops);
        }

        const ordenPorOp = new Map((ordenesPms || []).map(o => [String(o.op || '').trim(), o]));
        const produccionPorOp = new Map();

        for (const proc of procesos || []) {
            const op = String(proc.op || '').trim();
            if (!op || produccionPorOp.has(op)) continue;
            if (normalizarNumeroCuaderno(proc.cantidad_contada) === null) continue;
            produccionPorOp.set(op, normalizarNumeroCuaderno(proc.cantidad_contada) || 0);
        }

        const lirionPorOp = await obtenerEstadoLirionPorOps(ops);

        const filas = (filasBase || []).map((fila) => {
            const opAsignada = String(fila.op_asignada || '').trim();
            const opPms = opAsignada ? ordenPorOp.get(opAsignada) : null;
            const estadoLirion = opAsignada ? lirionPorOp.get(opAsignada) : null;
            const cantidadProducida = opAsignada ? (produccionPorOp.get(opAsignada) ?? null) : null;

            const cantidadSolicitada = normalizarNumeroCuaderno(fila.cantidad_solicitada_mt ?? fila.cantidad_pedida_mt);
            const faltante = cantidadSolicitada !== null && cantidadProducida !== null
                ? cantidadSolicitada - cantidadProducida
                : null;

            const cerradaPms = esEstadoFinalCuaderno(opPms?.estado);
            const cerradaLirion = String(estadoLirion?.docstatus || '').toUpperCase() === 'CO'
                && String(estadoLirion?.processed || '').toUpperCase() === 'Y';
            const bloqueado = cerradaPms || cerradaLirion;
            const completo = bloqueado || (faltante !== null && faltante <= 0);

            return {
                id: fila.id,
                row_key: `plan_${fila.id}`,
                cliente: fila.cliente || '',
                materia_prima: fila.materia_prima || '',
                producto: fila.producto || opPms?.producto_nombre || '',
                codigo_pt: fila.codigo_pt || opPms?.producto_codigo || '',
                cantidad_pedida_mt: fila.cantidad_pedida_mt ?? '',
                cantidad_pedida_un: fila.cantidad_pedida_un ?? '',
                pedido: fila.pedido || opPms?.numero_pedido || '',
                oc: fila.oc || 'S/N',
                cantidad_solicitada_mt: fila.cantidad_solicitada_mt ?? fila.cantidad_pedida_mt ?? '',
                cantidad_plan_mt: fila.cantidad_plan_mt ?? opPms?.cantidad_planificada ?? '',
                largo_corte: fila.largo_corte || '',
                factor: fila.factor || '1',
                cantidad_salida: calcularSalidaCuaderno(fila.cantidad_plan_mt ?? opPms?.cantidad_planificada, fila.factor),
                fecha: formatearFechaCuaderno(fila.fecha),
                op_asignada: opAsignada,
                impreso: fila.impreso || 'FALSO',
                cantidad_producida: cantidadProducida ?? '',
                faltante: faltante ?? '',
                dias_para_entrega: calcularDiasCuaderno(fila.fecha),
                completo_bool: completo,
                completo: completo ? 'VERDADERO' : 'FALSO',
                nota: fila.nota || '',
                estado_pms: opPms?.estado || '',
                estado_lirion: estadoLirion?.docstatus || '',
                lirion_processed: estadoLirion?.processed || '',
                bloqueado_edicion: bloqueado,
                modificado_manual: true,
                updated_by: fila.updated_by || fila.created_by || '',
                updated_at: fila.updated_at || fila.created_at || null
            };
        });

        res.json(filas);
    } catch (err) {
        console.error('❌ Error cargando formato cuaderno:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/planificacion/cuaderno', async (req, res) => {
    try {
        await asegurarTablaCuadernoProduccion();
        const fila = construirPayloadFilaCuaderno(req.body || {});

        if (!String(fila.producto || fila.codigo_pt || '').trim()) {
            return res.status(400).json({ error: 'Debe ingresar producto o código PT para crear una línea.' });
        }

        const result = await db.run(`
            INSERT INTO cuaderno_planificacion (
                cliente,
                materia_prima,
                producto,
                codigo_pt,
                cantidad_pedida_mt,
                cantidad_pedida_un,
                pedido,
                oc,
                cantidad_solicitada_mt,
                cantidad_plan_mt,
                largo_corte,
                factor,
                fecha,
                op_asignada,
                impreso,
                nota,
                created_by,
                created_at,
                updated_by,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            fila.cliente,
            fila.materia_prima,
            fila.producto,
            fila.codigo_pt,
            fila.cantidad_pedida_mt,
            fila.cantidad_pedida_un,
            fila.pedido,
            fila.oc,
            fila.cantidad_solicitada_mt,
            fila.cantidad_plan_mt,
            fila.largo_corte,
            fila.factor,
            fila.fecha,
            fila.op_asignada,
            fila.impreso,
            fila.nota,
            fila.usuario,
            toMySQLDate(new Date()),
            fila.usuario,
            toMySQLDate(new Date())
        ]);

        res.json({
            success: true,
            message: 'Línea del planner creada.',
            id: result?.insertId || result?.lastID || null
        });
    } catch (err) {
        console.error('❌ Error creando línea de cuaderno:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/planificacion/cuaderno/:rowKey', async (req, res) => {
    const id = extraerIdCuaderno(req.params.rowKey);

    if (!id) {
        return res.status(400).json({ error: 'Identificador de fila inválido.' });
    }

    try {
        await asegurarTablaCuadernoProduccion();

        const actual = await db.get(`SELECT * FROM cuaderno_planificacion WHERE id = ? LIMIT 1`, [id]);
        if (!actual) {
            return res.status(404).json({ error: 'No se encontró la línea del cuaderno.' });
        }

        const estabaCerrada = await filaCuadernoEstaCerrada(actual.op_asignada);
        if (estabaCerrada) {
            return res.status(409).json({ error: 'Esta línea ya tiene una OP cerrada/completada. Se muestra como historial y no se puede editar.' });
        }

        const fila = construirPayloadFilaCuaderno(req.body || {});

        await db.run(`
            UPDATE cuaderno_planificacion
            SET cliente = ?,
                materia_prima = ?,
                producto = ?,
                codigo_pt = ?,
                cantidad_pedida_mt = ?,
                cantidad_pedida_un = ?,
                pedido = ?,
                oc = ?,
                cantidad_solicitada_mt = ?,
                cantidad_plan_mt = ?,
                largo_corte = ?,
                factor = ?,
                fecha = ?,
                op_asignada = ?,
                impreso = ?,
                nota = ?,
                updated_by = ?,
                updated_at = ?
            WHERE id = ?
        `, [
            fila.cliente,
            fila.materia_prima,
            fila.producto,
            fila.codigo_pt,
            fila.cantidad_pedida_mt,
            fila.cantidad_pedida_un,
            fila.pedido,
            fila.oc,
            fila.cantidad_solicitada_mt,
            fila.cantidad_plan_mt,
            fila.largo_corte,
            fila.factor,
            fila.fecha,
            fila.op_asignada,
            fila.impreso,
            fila.nota,
            fila.usuario,
            toMySQLDate(new Date()),
            id
        ]);

        res.json({ success: true, message: 'Línea del planner actualizada.', id });
    } catch (err) {
        console.error('❌ Error guardando línea de cuaderno:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/planificacion/cuaderno/:rowKey', async (req, res) => {
    const id = extraerIdCuaderno(req.params.rowKey);

    if (!id) {
        return res.status(400).json({ error: 'Identificador de fila inválido.' });
    }

    try {
        await asegurarTablaCuadernoProduccion();

        const actual = await db.get(`SELECT * FROM cuaderno_planificacion WHERE id = ? LIMIT 1`, [id]);
        if (!actual) {
            return res.status(404).json({ error: 'No se encontró la línea del cuaderno.' });
        }

        const cerrada = await filaCuadernoEstaCerrada(actual.op_asignada);
        if (cerrada) {
            return res.status(409).json({ error: 'Esta línea ya tiene una OP cerrada/completada. No se puede eliminar.' });
        }

        await db.run(`DELETE FROM cuaderno_planificacion WHERE id = ?`, [id]);
        res.json({ success: true, message: 'Línea del planner eliminada.', id });
    } catch (err) {
        console.error('❌ Error eliminando línea de cuaderno:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/operacion/historial-op/:op', async (req, res) => {
    const { op } = req.params;
    try {
        const pasos = await db.all(`
            SELECT p.*, m.nombre as nombre_maquina, u.nombre as nombre_operador
            FROM procesos p
            JOIN maquinas m ON p.maquina_id = m.id
            JOIN usuarios u ON p.operador_id = u.id
            WHERE p.op = ?
            ORDER BY p.fecha_entrada ASC
        `, [op]);
        const infoBase = await db.get("SELECT producto_codigo, producto_nombre FROM ordenes_planificacion WHERE op = ?", [op]);
        res.json({ infoBase, pasos });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/operacion/expediente-completo/:op', async (req, res) => {
    const { op } = req.params;
    try {
        const plan = await db.get(`SELECT * FROM ordenes_planificacion WHERE op = ?`, [op]);
        if (!plan) return res.status(404).json({ error: "No se encontró el plan maestro." });

        const pasos = await db.all(`
            SELECT p.*, m.nombre as nombre_maquina, u.nombre as nombre_operador
            FROM procesos p
            LEFT JOIN maquinas m ON p.maquina_id = m.id
            LEFT JOIN usuarios u ON p.operador_id = u.id
            WHERE p.op = ?
            ORDER BY p.fecha_entrada ASC
        `, [op]);

        const auditoria = await db.all(`SELECT * FROM trazabilidad WHERE op = ? ORDER BY fecha DESC`, [op]);

        res.json({ plan, pasos: pasos || [], auditoria: auditoria || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/formularios/pendientes/:rol', async (req, res) => {
    const rolNormalizado = String(req.params.rol || '').toLowerCase().trim();

    // Supervisor debe ver OP en producción cuando estén en curso, y también cuando ya completaron
    // todas sus etapas aunque la orden todavía siga internamente como EN_PROCESO.
    // Calidad solo debe ver lo que el supervisor ya aprobó.
    let filtroEstado = "op.estado = 'PENDIENTE'";

    if (rolNormalizado === 'supervisor') {
        filtroEstado = "op.estado IN ('PENDIENTE', 'EN_PROCESO')";
    } else if (rolNormalizado === 'calidad') {
        filtroEstado = "op.estado = 'PENDIENTE_CALIDAD'";
    }

    try {
        const query = `
            SELECT 
                op.op, 
                op.producto_nombre as maquina, 
                op.ruta_tecnica,
                (SELECT u.nombre FROM procesos p2 JOIN usuarios u ON p2.operador_id = u.id WHERE p2.op = op.op ORDER BY p2.fecha_entrada DESC LIMIT 1) as nombre_operador, 
                op.estado, 
                op.fecha_creacion,
                COALESCE((
                    SELECT p3.cantidad_contada
                    FROM procesos p3
                    WHERE p3.op = op.op
                      AND p3.estado = 'FINALIZADO'
                      AND p3.cantidad_contada IS NOT NULL
                    ORDER BY p3.fecha_salida DESC, p3.id DESC
                    LIMIT 1
                ), 0) as cantidad_contada,
                (SELECT SUM(cantidad_merma) FROM procesos p4 WHERE p4.op = op.op) as cantidad_merma,
                (SELECT COUNT(*) FROM procesos p5 WHERE p5.op = op.op AND p5.estado = 'EN_PROCESO') as procesos_activos,
                (SELECT COUNT(*) FROM procesos p7 WHERE p7.op = op.op AND p7.estado = 'FINALIZADO') as procesos_finalizados,
                (SELECT COUNT(*) FROM procesos p8 WHERE p8.op = op.op) as total_pasos_registrados,
                (SELECT area_proceso FROM procesos p6 WHERE p6.op = op.op ORDER BY p6.fecha_entrada DESC LIMIT 1) as etapa_actual
            FROM ordenes_planificacion op
            WHERE ${filtroEstado}
            ORDER BY op.fecha_creacion DESC
        `;

        let registros = await db.all(query);

        if (rolNormalizado === 'supervisor') {
            registros = (registros || []).filter((r) => {
                const procesosActivos = Number(r.procesos_activos || 0);
                const procesosFinalizados = Number(r.procesos_finalizados || 0);

                let totalEtapas = 0;
                try {
                    const ruta = typeof r.ruta_tecnica === 'string' ? JSON.parse(r.ruta_tecnica || '[]') : r.ruta_tecnica;
                    totalEtapas = Array.isArray(ruta) ? ruta.length : 0;
                } catch (e) {
                    totalEtapas = 0;
                }

                if (procesosActivos > 0) return true;
                return totalEtapas > 0 && procesosFinalizados >= totalEtapas;
            });
        }

        res.json((registros || []).map(({ ruta_tecnica, ...r }) => r));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/formularios/usuario/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        // console.log(`📋 Cargando últimos registros del operador ID: ${userId}`);

        const procesos = await db.all(`
            SELECT 
                id,
                op,
                area_proceso,
                estado,
                fecha_entrada,
                fecha_salida
            FROM procesos
            WHERE operador_id = ?
            ORDER BY id DESC
            LIMIT 20
        `, [userId]);

        const eventos = [];

        for (const p of procesos || []) {
            if (p.fecha_entrada) {
                eventos.push({
                    id: p.id,
                    op: p.op,
                    area_proceso: p.area_proceso || 'Sin etapa',
                    estado: p.estado || 'SIN ESTADO',
                    fecha_creacion: p.fecha_entrada,
                    tipo_evento: 'INICIO_PROCESO',
                    tipo_evento_label: 'Inicio de proceso'
                });
            }

            if (p.fecha_salida) {
                eventos.push({
                    id: p.id,
                    op: p.op,
                    area_proceso: p.area_proceso || 'Sin etapa',
                    estado: p.estado || 'SIN ESTADO',
                    fecha_creacion: p.fecha_salida,
                    tipo_evento: 'CIERRE_PROCESO',
                    tipo_evento_label: 'Cierre de proceso'
                });
            }
        }

        eventos.sort((a, b) => {
            const fechaA = new Date(a.fecha_creacion).getTime() || 0;
            const fechaB = new Date(b.fecha_creacion).getTime() || 0;
            return fechaB - fechaA;
        });

        // console.log(`✅ Historial operador ${userId}: ${eventos.length} eventos encontrados`);

        res.json(eventos.slice(0, 5));

    } catch (err) {
        // console.error('❌ Error cargando historial del usuario:', err);
        res.status(500).json({
            error: err.message,
            detalle: 'Falló /api/formularios/usuario/:userId'
        });
    }
});

app.post('/api/formularios', async (req, res) => {
    const { op, cantidad_contada, cantidad_merma, comentarios_operador, detalle_mermas, materiales_utilizados, mermasArray, detalle_ocurrencias } = req.body;
    try {
        const procesoActivo = await db.get("SELECT id FROM procesos WHERE op = ? AND estado = 'EN_PROCESO' ORDER BY fecha_entrada DESC LIMIT 1", [op]);
        if (!procesoActivo) return res.status(404).json({ error: "No se encontró el proceso activo." });

        let mermasDB = detalle_mermas;
        if (mermasArray && Array.isArray(mermasArray)) mermasDB = JSON.stringify(mermasArray);
        else if (typeof detalle_mermas === 'object') mermasDB = JSON.stringify(detalle_mermas);

        let ocurrenciasDB = detalle_ocurrencias;
        if (typeof detalle_ocurrencias === 'object') ocurrenciasDB = JSON.stringify(detalle_ocurrencias);

        await db.run(`
            UPDATE procesos SET cantidad_contada = ?, cantidad_merma = ?, detalle_mermas = ?, comentarios_operador = ?,
            materiales_utilizados = COALESCE(?, materiales_utilizados), detalle_ocurrencias = ? WHERE id = ?
        `, [cantidad_contada, cantidad_merma, mermasDB, comentarios_operador, materiales_utilizados, ocurrenciasDB, procesoActivo.id]);

        res.json({ message: 'Información de etapa guardada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/procesos/activo/:operador_id', async (req, res) => {
    const { operador_id } = req.params;
    try {
        const proceso = await db.get(`
            SELECT p.*, m.nombre as nombre_maquina, m.area FROM procesos p 
            JOIN maquinas m ON p.maquina_id = m.id 
            WHERE p.operador_id = ? AND p.estado = 'EN_PROCESO' LIMIT 1
        `, [operador_id]);
        res.json(proceso || null);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/procesos/entrada', autenticarPMSOpcional, async (req, res) => {
    const {
        operador_id,
        maquina_id,
        op,
        materiales_iniciales,
        area_proceso,
        etapa_proceso,
        adempiere_user_id
    } = req.body;

    try {
        const ocupada = await db.get(
            "SELECT id FROM procesos WHERE op = ? AND estado = 'EN_PROCESO'",
            [op]
        );

        if (ocupada) {
            throw new Error('Esta OP ya está siendo procesada');
        }

        const maquina = await db.get(
            "SELECT id, nombre, area, estado FROM maquinas WHERE id = ?",
            [maquina_id]
        );

        if (!maquina) {
            throw new Error('Máquina no encontrada.');
        }

        let etapaFinal = etapa_proceso || area_proceso || null;

        if (!etapaFinal && materiales_iniciales) {
            try {
                const mats = typeof materiales_iniciales === 'string'
                    ? JSON.parse(materiales_iniciales)
                    : materiales_iniciales;

                if (Array.isArray(mats) && mats.length > 0) {
                    etapaFinal = mats[0].etapa_nombre || mats[0].area || null;
                }
            } catch (e) {
                etapaFinal = null;
            }
        }

        etapaFinal = etapaFinal || maquina.area || 'Sin etapa';

        // Nuevo flujo: el operador selecciona ubicación/lote por insumo y esas líneas se actualizan en Lirion.
        // Esto mantiene la OP en borrador, pero deja las líneas de consumo con lote, ubicación y cantidad real.
        const materialesOperador = parseJsonArraySeguro(materiales_iniciales, []);
        const userIdLirionOperador = req.user?.adempiere_user_id ||
            req.user?.lirion_ad_user_id ||
            req.user?.ad_user_id ||
            adempiere_user_id;

        const clientLirion = await poolIdempiere.connect();
        let actualizacionLirion = null;
        try {
            await clientLirion.query('BEGIN');
            actualizacionLirion = await actualizarLineasProduccionPorOperadorEnLirion(clientLirion, {
                op,
                etapa: etapaFinal,
                materiales: materialesOperador,
                updatedBy: userIdLirionOperador
            });
            await clientLirion.query('COMMIT');
        } catch (lirionErr) {
            try { await clientLirion.query('ROLLBACK'); } catch (_) { }
            throw lirionErr;
        } finally {
            clientLirion.release();
        }

        await db.run(
            `INSERT INTO procesos (
                operador_id, 
                maquina_id, 
                op, 
                area_proceso, 
                materiales_utilizados, 
                estado, 
                fecha_entrada
             ) VALUES (?, ?, ?, ?, ?, 'EN_PROCESO', ?)`,
            [
                operador_id,
                maquina_id,
                op,
                etapaFinal,
                materiales_iniciales,
                toMySQLDate(new Date())
            ]
        );

        await db.run(
            'UPDATE maquinas SET estado = "OCUPADA" WHERE id = ?',
            [maquina_id]
        );

        // ✅ REGISTRO EN HOJA DE VIDA DE LA MÁQUINA
        await db.run(`
            INSERT INTO historial_maquinas (
                maquina_id, 
                estado_anterior, 
                estado_nuevo, 
                motivo, 
                comentario, 
                usuario_id, 
                fecha
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            maquina_id,
            maquina.estado || 'DISPONIBLE',
            'OCUPADA',
            'INICIO_PROCESO',
            `Inicio de proceso | OP ${op} | Etapa ${etapaFinal}`,
            operador_id,
            toMySQLDate(new Date())
        ]);

        const procesoActivo = await db.get(`
            SELECT p.*, m.nombre as nombre_maquina, m.area 
            FROM procesos p 
            JOIN maquinas m ON p.maquina_id = m.id 
            WHERE p.operador_id = ? 
              AND p.op = ?
              AND p.estado = 'EN_PROCESO'
            ORDER BY p.fecha_entrada DESC
            LIMIT 1
        `, [operador_id, op]);

        res.json({
            message: 'Entrada registrada',
            proceso: procesoActivo,
            lirion: actualizacionLirion
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/procesos/finalizar/:proceso_id', async (req, res) => {
    const { proceso_id } = req.params;
    const { maquina_id } = req.body;

    try {
        const proceso = await db.get(`
            SELECT 
                p.id,
                p.op,
                p.operador_id,
                p.maquina_id,
                p.area_proceso,
                m.estado as estado_maquina,
                m.nombre as nombre_maquina
            FROM procesos p
            JOIN maquinas m ON p.maquina_id = m.id
            WHERE p.id = ?
            LIMIT 1
        `, [proceso_id]);

        if (!proceso) {
            throw new Error('Proceso no encontrado.');
        }

        const maquinaIdFinal = maquina_id || proceso.maquina_id;
        const operadorId = proceso.operador_id;
        const etapaFinal = proceso.area_proceso || 'Sin etapa';

        await db.run(
            `UPDATE procesos 
             SET estado = 'FINALIZADO', fecha_salida = ? 
             WHERE id = ?`,
            [toMySQLDate(new Date()), proceso_id]
        );

        await db.run(
            `UPDATE maquinas SET estado = 'DISPONIBLE' WHERE id = ?`,
            [maquinaIdFinal]
        );

        await db.run(`
            INSERT INTO historial_maquinas (
                maquina_id, estado_anterior, estado_nuevo, motivo, comentario, usuario_id, fecha
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            maquinaIdFinal,
            proceso.estado_maquina || 'OCUPADA',
            'DISPONIBLE',
            'CIERRE_PROCESO',
            `Fin de etapa productiva | OP ${proceso.op} | Etapa ${etapaFinal}`,
            operadorId,
            toMySQLDate(new Date())
        ]);

        // Si esta fue la última etapa de la ruta, la OP queda pendiente de revisión de Supervisor.
        const ordenPlan = await db.get(
            `SELECT op, estado, ruta_tecnica FROM ordenes_planificacion WHERE op = ? LIMIT 1`,
            [proceso.op]
        );

        if (ordenPlan) {
            let totalEtapas = 0;
            try {
                const ruta = typeof ordenPlan.ruta_tecnica === 'string'
                    ? JSON.parse(ordenPlan.ruta_tecnica || '[]')
                    : ordenPlan.ruta_tecnica;
                totalEtapas = Array.isArray(ruta) ? ruta.length : 0;
            } catch (e) {
                totalEtapas = 0;
            }

            const conteoFinalizadas = await db.get(
                `SELECT COUNT(*) AS total FROM procesos WHERE op = ? AND estado = 'FINALIZADO'`,
                [proceso.op]
            );

            const etapasFinalizadas = Number(conteoFinalizadas?.total || 0);
            const estadoActualOrden = String(ordenPlan.estado || '').toUpperCase();

            if (totalEtapas > 0 && etapasFinalizadas >= totalEtapas && estadoActualOrden === 'EN_PROCESO') {
                await db.run(
                    `UPDATE ordenes_planificacion SET estado = 'PENDIENTE' WHERE op = ?`,
                    [proceso.op]
                );
            }
        }

        res.json({ message: 'Máquina liberada' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// HELPERS MERMAS / CALIDAD -> LIRION
// ==========================================
function obtenerCreadorLirionSeguro(adempiere_user_id) {
    const creadorId = Number(adempiere_user_id);

    if (!Number.isFinite(creadorId) || creadorId <= 0 || creadorId === 100) {
        throw new Error('No se pudo determinar el usuario real de Lirion. No se insertará merma con SuperUser.');
    }

    return creadorId;
}

function parsearMermasDesdeDato(d) {
    if (!d) return [];

    if (Array.isArray(d.mermas)) return d.mermas;

    if (typeof d.mermas === 'string' && d.mermas.trim() !== '') {
        try {
            const parsed = JSON.parse(d.mermas);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    if (Array.isArray(d.detalle_mermas)) return d.detalle_mermas;

    if (typeof d.detalle_mermas === 'string' && d.detalle_mermas.trim() !== '') {
        try {
            const parsed = JSON.parse(d.detalle_mermas);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    return [];
}

async function resolverScrapId(client, merma) {
    const scrapIdDirecto = Number(
        merma?.motivo_id ||
        merma?.cds_scrap_id ||
        merma?.id
    );

    if (Number.isFinite(scrapIdDirecto) && scrapIdDirecto > 0) {
        return scrapIdDirecto;
    }

    const scrapName = String(
        merma?.motivo_nombre ||
        merma?.name ||
        merma?.motivo ||
        ''
    ).trim();

    if (!scrapName) {
        throw new Error('Una merma no tiene motivo seleccionado.');
    }

    const resScrap = await client.query(`
        SELECT cds_scrap_id
        FROM adempiere.cds_scrap
        WHERE isactive = 'Y'
          AND (
              LOWER(TRIM(name)) = LOWER(TRIM($1))
              OR LOWER(TRIM(value)) = LOWER(TRIM($1))
          )
        ORDER BY updated DESC, created DESC
        LIMIT 1
    `, [scrapName]);

    if (!resScrap.rows.length) {
        throw new Error(`No se encontró motivo de merma en Lirion: ${scrapName}`);
    }

    return Number(resScrap.rows[0].cds_scrap_id);
}

function obtenerNombreMerma(merma) {
    return String(
        merma?.motivo_nombre ||
        merma?.name ||
        merma?.motivo ||
        'Merma'
    ).trim();
}

async function asegurarTablaNotificaciones() {
    await db.run(`
        CREATE TABLE IF NOT EXISTS notificaciones (
            id INT AUTO_INCREMENT PRIMARY KEY,
            usuario_id INT NULL,
            rol_destino VARCHAR(50) NOT NULL,
            op VARCHAR(100) NOT NULL,
            tipo VARCHAR(80) NOT NULL,
            titulo VARCHAR(255) NOT NULL,
            mensaje TEXT,
            leida TINYINT(1) NOT NULL DEFAULT 0,
            fecha_creacion DATETIME NOT NULL,
            fecha_lectura DATETIME NULL
        )
    `);
}

async function notificarPlanificacionPendienteCierre(op, usuarioCalidad, produccionTotal) {
    const planificadores = await db.all(`
        SELECT id
        FROM usuarios
        WHERE LOWER(rol) = 'planificacion'
          AND COALESCE(activo, 1) = 1
    `);

    const titulo = `OP ${op} pendiente de aprobación de Planificación`;
    const mensaje = `Calidad aprobó la OP ${op}. Debe revisar el resumen y completar el documento en Lirion. Calidad: ${usuarioCalidad || 'N/A'}. Producción total: ${Number(produccionTotal || 0)}.`;
    const fecha = toMySQLDate(new Date());

    if (!planificadores || planificadores.length === 0) {
        await db.run(`
            INSERT INTO notificaciones
                (usuario_id, rol_destino, op, tipo, titulo, mensaje, leida, fecha_creacion)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `, [null, 'planificacion', op, 'PENDIENTE_APROBACION_PLANIFICACION', titulo, mensaje, fecha]);
        return;
    }

    for (const usuario of planificadores) {
        await db.run(`
            INSERT INTO notificaciones
                (usuario_id, rol_destino, op, tipo, titulo, mensaje, leida, fecha_creacion)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        `, [usuario.id, 'planificacion', op, 'PENDIENTE_APROBACION_PLANIFICACION', titulo, mensaje, fecha]);
    }
}

async function marcarNotificacionesPlanificacionLeidas(op, usuarioId = null) {
    try {
        await asegurarTablaNotificaciones();
        if (usuarioId) {
            await db.run(`
                UPDATE notificaciones
                SET leida = 1, fecha_lectura = ?
                WHERE op = ? AND rol_destino = 'planificacion' AND (usuario_id = ? OR usuario_id IS NULL)
            `, [toMySQLDate(new Date()), op, usuarioId]);
        } else {
            await db.run(`
                UPDATE notificaciones
                SET leida = 1, fecha_lectura = ?
                WHERE op = ? AND rol_destino = 'planificacion'
            `, [toMySQLDate(new Date()), op]);
        }
    } catch (err) {
        console.warn('⚠️ No se pudieron marcar notificaciones como leídas:', err.message);
    }
}


app.post('/api/gestion/finalizar-expediente', async (req, res) => {
    const {
        op,
        aprobado,
        usuario_firma,
        rol_firma,
        logs,
        datos_corregidos,
        produccion_total,
        adempiere_user_id
    } = req.body;

    try {
        const creadorId = obtenerCreadorLirionSeguro(adempiere_user_id);

        const rolFirmaNormalizado = String(rol_firma || '').toLowerCase();

        const nuevoEstado = !aprobado
            ? 'RECHAZADO'
            : (
                rolFirmaNormalizado === 'supervisor'
                    ? 'PENDIENTE_CALIDAD'
                    : (
                        rolFirmaNormalizado === 'calidad'
                            ? 'PENDIENTE_APROBACION_PLANIFICACION'
                            : 'FINALIZADO'
                    )
            );

        const produccionTotalSinSumarEtapas = calcularProduccionFinalNoSumada(datos_corregidos, produccion_total);

        await db.run(
            `UPDATE ordenes_planificacion SET estado = ? WHERE op = ?`,
            [nuevoEstado, op]
        );

        // Notificación interna: cuando Calidad aprueba, Planificación debe dar el cierre final.
        if (aprobado && rolFirmaNormalizado === 'calidad') {
            try {
                await asegurarTablaNotificaciones();
                await notificarPlanificacionPendienteCierre(op, usuario_firma, produccionTotalSinSumarEtapas);
            } catch (notifErr) {
                console.warn('⚠️ No se pudo registrar notificación para Planificación:', notifErr.message);
            }
        }

        if (logs && logs.length > 0) {
            for (const log of logs) {
                await db.run(
                    `INSERT INTO trazabilidad 
                     (op, usuario, rol, fecha, tipo_cambio, contexto, valor_anterior, valor_nuevo) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        op,
                        log.usuario,
                        log.rol,
                        toMySQLDate(log.fecha),
                        log.tipo_cambio,
                        log.contexto,
                        log.valor_anterior,
                        log.valor_nuevo
                    ]
                );
            }
        }

        if (datos_corregidos && datos_corregidos.length > 0) {
            for (const d of datos_corregidos) {
                await db.run(
                    `UPDATE procesos 
                     SET cantidad_contada = ?, 
                         cantidad_merma = ?, 
                         materiales_utilizados = ?, 
                         detalle_mermas = ?, 
                         detalle_ocurrencias = ? 
                     WHERE id = ?`,
                    [
                        d.cantidad_contada,
                        d.cantidad_merma,
                        d.materiales,
                        d.mermas,
                        d.ocurrencias,
                        d.id
                    ]
                );
            }
        }

        // Calidad sincroniza producción/mermas en Lirion, pero NO completa el documento.
        // El documento queda en borrador hasta que Planificación haga el cierre final.
        if (aprobado && rolFirmaNormalizado === 'calidad') {
            const client = await poolIdempiere.connect();

            try {
                await client.query('BEGIN');

                // Relación correcta:
                // M_Production.documentno = OP
                // -> M_ProductionLine.m_production_id
                // -> CDS_PRODUCTIONSCRAP.m_productionline_id
                const resLine = await client.query(`
                    SELECT 
                        p.m_production_id,
                        p.documentno,
                        p.docstatus,
                        p.processed,
                        pl.m_productionline_id,
                        pl.m_product_id,
                        pl.movementqty,
                        pl.scrappedqty
                    FROM adempiere.m_production p
                    JOIN adempiere.m_productionline pl 
                      ON pl.m_production_id = p.m_production_id
                    WHERE regexp_replace(UPPER(TRIM(p.documentno)), '[^A-Z0-9]', '', 'g') =
                          regexp_replace(UPPER(TRIM($1)), '[^A-Z0-9]', '', 'g')
                      AND p.isactive = 'Y'
                      AND pl.isactive = 'Y'
                      AND COALESCE(pl.isendproduct, 'N') = 'Y'
                    ORDER BY pl.line ASC, pl.m_productionline_id ASC
                    LIMIT 1
                `, [op]);

                if (!resLine.rows.length) {
                    throw new Error(`No se encontró la línea de producto final en Lirion para la OP ${op}.`);
                }

                const existingProductionId = Number(resLine.rows[0].m_production_id);
                const existingLineId = Number(resLine.rows[0].m_productionline_id);

                const produccionTotalFinal = Number(produccionTotalSinSumarEtapas || 0);

                if (!Number.isFinite(produccionTotalFinal) || produccionTotalFinal < 0) {
                    throw new Error(`Producción total inválida para OP ${op}: ${produccionTotalSinSumarEtapas}`);
                }

                // Actualizar cantidad final declarada en la misma OP.
                await client.query(`
                    UPDATE adempiere.m_production
                    SET productionqty = $1,
                        updated = NOW(),
                        updatedby = $2
                    WHERE m_production_id = $3
                `, [
                    produccionTotalFinal,
                    creadorId,
                    existingProductionId
                ]);

                await client.query(`
                    UPDATE adempiere.m_productionline
                    SET movementqty = $1,
                        plannedqty = $1,
                        updated = NOW(),
                        updatedby = $2
                    WHERE m_productionline_id = $3
                `, [
                    produccionTotalFinal,
                    creadorId,
                    existingLineId
                ]);

                // Recolectar mermas desde todos los procesos corregidos.
                const mermasFinales = [];

                for (const d of (datos_corregidos || [])) {
                    const mermasArray = parsearMermasDesdeDato(d);

                    for (const m of mermasArray) {
                        const cantidadMerma = Number(m?.cantidad || m?.scrappedqty || 0);

                        if (Number.isFinite(cantidadMerma) && cantidadMerma > 0) {
                            mermasFinales.push({
                                ...m,
                                cantidad: cantidadMerma,
                                proceso_id: d.id || null
                            });
                        }
                    }
                }

                const totalMerma = mermasFinales.reduce(
                    (sum, m) => sum + Number(m.cantidad || 0),
                    0
                );

                // Evitar duplicados: borrar solo mermas creadas por el PMS para esta OP.
                // No borra mermas manuales creadas directamente en Lirion.
                await client.query(`
                    DELETE FROM adempiere.cds_productionscrap
                    WHERE m_productionline_id = $1
                      AND (
                          description ILIKE $2
                          OR description ILIKE $3
                      )
                `, [
                    existingLineId,
                    `PMS OP ${op}%`,
                    `Merma OP ${op}:%`
                ]);

                // Insertar mermas nuevas en CDS_PRODUCTIONSCRAP.
                const maxScrapRes = await client.query(`
                    SELECT COALESCE(MAX(cds_productionscrap_id), 0) AS max_id
                    FROM adempiere.cds_productionscrap
                `);

                let currentScrapId = Number(maxScrapRes.rows[0].max_id || 0);

                for (const merma of mermasFinales) {
                    const scrapId = await resolverScrapId(client, merma);
                    const scrapName = obtenerNombreMerma(merma);
                    const cantidadMerma = Number(merma.cantidad || 0);
                    const descripcionMerma = String(
                        merma?.descripcion_lirion ||
                        merma?.descripcion ||
                        `PMS OP ${op} | Merma: ${scrapName}`
                    ).substring(0, 255);

                    currentScrapId++;

                    await client.query(`
                        INSERT INTO adempiere.cds_productionscrap (
                            cds_productionscrap_id,
                            ad_client_id,
                            ad_org_id,
                            cds_productionscrap_uu,
                            created,
                            createdby,
                            updated,
                            updatedby,
                            description,
                            scrappedqty,
                            cds_scrap_id,
                            m_productionline_id
                        ) VALUES (
                            $1,
                            1000000,
                            1000000,
                            $2,
                            NOW(),
                            $3,
                            NOW(),
                            $3,
                            $4,
                            $5,
                            $6,
                            $7
                        )
                    `, [
                        currentScrapId,
                        uuidv4(),
                        creadorId,
                        descripcionMerma,
                        cantidadMerma,
                        scrapId,
                        existingLineId
                    ]);
                }

                // Reflejar total de merma en la línea final.
                await client.query(`
                    UPDATE adempiere.m_productionline
                    SET scrappedqty = $1,
                        updated = NOW(),
                        updatedby = $2
                    WHERE m_productionline_id = $3
                `, [
                    totalMerma,
                    creadorId,
                    existingLineId
                ]);

                await client.query('COMMIT');

                console.log(`✅ Mermas sincronizadas en Lirion para OP ${op}. M_Production_ID=${existingProductionId}, M_ProductionLine_ID=${existingLineId}, Total merma=${totalMerma}`);

            } catch (err) {
                await client.query('ROLLBACK');
                console.error('❌ Error sincronizando merma en Lirion:', err.message);
                throw err;
            } finally {
                client.release();
            }
        }

        res.json({
            success: true,
            estado_final: nuevoEstado
        });

    } catch (err) {
        console.error('❌ Error finalizar-expediente:', err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ==========================================
// MÁQUINAS Y DASHBOARD
// ==========================================

app.get('/api/maquinas/disponibles', async (req, res) => {
    try {
        const maquinas = await db.all("SELECT * FROM maquinas WHERE estado = 'DISPONIBLE' ORDER BY area, nombre");
        res.json(maquinas);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/maquinas/estado-total', async (req, res) => {
    try {
        const maquinas = await db.all(`
            SELECT m.*, p.op as op_actual, u.nombre as operador_actual
            FROM maquinas m
            LEFT JOIN procesos p ON m.id = p.maquina_id AND p.estado = 'EN_PROCESO'
            LEFT JOIN usuarios u ON p.operador_id = u.id
            ORDER BY m.area, m.nombre
        `);
        res.json(maquinas);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/maquinas/cambiar-estado', async (req, res) => {
    const { maquina_id, nuevo_estado, motivo, comentario, usuario_id, area } = req.body;
    try {
        const anterior = await db.get("SELECT estado, area FROM maquinas WHERE id = ?", [maquina_id]);
        const areaFinal = area || anterior.area;
        const estadoFinal = nuevo_estado || anterior.estado;

        await db.run("UPDATE maquinas SET estado = ?, area = ? WHERE id = ?", [estadoFinal, areaFinal, maquina_id]);
        await db.run(`INSERT INTO historial_maquinas (maquina_id, estado_anterior, estado_nuevo, motivo, comentario, usuario_id, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [maquina_id, anterior.estado, estadoFinal, motivo, comentario, usuario_id, toMySQLDate(new Date())]
        );
        res.json({ message: 'Máquina actualizada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/maquinas/historial/:maquina_id', async (req, res) => {
    try {
        const historial = await db.all(`
            SELECT h.*, u.nombre as responsable FROM historial_maquinas h
            LEFT JOIN usuarios u ON h.usuario_id = u.id WHERE h.maquina_id = ? ORDER BY h.fecha DESC LIMIT 50
        `, [req.params.maquina_id]);
        res.json(historial);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/pendientes-lirion', async (req, res) => {
    try {
        const result = await poolIdempiere.query(`
            SELECT documentno as pedido, bp.name as cliente, datepromised::date as fecha
            FROM C_Order o JOIN C_BPartner bp ON o.c_bpartner_id = bp.c_bpartner_id
            WHERE o.issotrx = 'Y' AND o.docstatus = 'CO' AND o.c_doctypetarget_id = 1000493
              AND o.datepromised::date >= CURRENT_DATE AND o.datepromised::date <= (CURRENT_DATE + INTERVAL '7 days')
            ORDER BY o.datepromised ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/fabricados-ayer', async (req, res) => {
    try {
        const rows = await db.all(`SELECT op, cliente FROM ordenes_planificacion WHERE estado = 'FINALIZADO' AND DATE(fecha_creacion) = CURDATE() - INTERVAL 1 DAY`);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// LOGIN Y USUARIOS
// ==========================================


// Endpoint para obtener información inicial (Clientes y Token Crudo)
app.post('/api/login/info', async (req, res) => {
    const { username, password } = req.body;
    const serverType = req.headers['x-server-type'] || 'test';
    
    if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });

    try {
        const data = await httpsJsonRequest({
            path: '/api/v1/auth/tokens', method: 'POST',
            body: { userName: username, password }, serverType
        });
        res.json({ clients: data.clients || [], rawToken: data.token });
    } catch (err) {
        // En caso de fallar Lirion, verificar si el usuario existe y es válido en la base de datos local (ej. admin)
        try {
            const localUser = await db.get('SELECT * FROM usuarios WHERE LOWER(username) = LOWER(?) AND activo = 1', [username]);
            if (localUser) {
                const passwordMatch = (password === localUser.password) || bcrypt.compareSync(password, localUser.password);
                if (passwordMatch) {
                    // Retornar clients vacíos forza al frontend a ejecutar onLoginFinal que resuelve el login local
                    return res.json({ clients: [], rawToken: '', localOnly: true });
                }
            }
        } catch (dbErr) {
            console.error("Error al consultar DB local:", dbErr);
        }

        res.status(err.statusCode || 500).json({ error: "Credenciales incorrectas o error de conexión: " + err.message });
    }
});

// ==========================================
// CONFIGURACIÓN GLOBAL
// ==========================================
app.get('/api/config', async (req, res) => {
    try {
        const rows = await db.all('SELECT clave, valor FROM configuracion');
        const config = {};
        if (rows && rows.length > 0) {
            rows.forEach(r => config[r.clave] = r.valor);
        }
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/config', async (req, res) => {
    try {
        const { allow_server_change, default_server } = req.body;
        await db.run('UPDATE configuracion SET valor = ? WHERE clave = ?', [String(allow_server_change), 'allow_server_change']);
        await db.run('UPDATE configuracion SET valor = ? WHERE clave = ?', [default_server, 'default_server']);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoints auxiliares para selectores dinámicos
app.get('/api/roles', async (req, res) => {
    const { client } = req.query;
    const token = req.headers['x-raw-token'];
    const serverType = req.headers['x-server-type'] || 'test';
    try {
        const data = await httpsJsonRequest({ path: `/api/v1/auth/roles?client=${client}`, method: 'GET', token, serverType });
        res.json(data.roles || []);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/organizations', async (req, res) => {
    const { client, role } = req.query;
    const token = req.headers['x-raw-token'];
    const serverType = req.headers['x-server-type'] || 'test';
    try {
        const data = await httpsJsonRequest({ path: `/api/v1/auth/organizations?client=${client}&role=${role}`, method: 'GET', token, serverType });
        res.json(data.organizations || []);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/warehouses', async (req, res) => {
    const { client, role, organization } = req.query;
    const token = req.headers['x-raw-token'];
    const serverType = req.headers['x-server-type'] || 'test';
    try {
        const data = await httpsJsonRequest({ path: `/api/v1/auth/warehouses?client=${client}&role=${role}&organization=${organization}`, method: 'GET', token, serverType });
        res.json(data.warehouses || []);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.post('/api/auth/login', async (req, res) => {
    const { username, password, clientId, roleId, organizationId, warehouseId } = req.body;
    const serverType = req.headers['x-server-type'] || 'test';
    
    console.log('--- LOGIN REQUEST ---', { username, password: '***', clientId, roleId, organizationId, warehouseId, serverType });

    try {
        let loginLirion = { ok: false, statusCode: 401, body: {} };

        try {
            // Si el cliente envía IDs explícitos, usamos la vía directa (Final step login multi-step)
            if (clientId !== undefined && roleId !== undefined && organizationId !== undefined) {
                const bodyParams = {
                    userName: username, password,
                    parameters: { language: 'es_CL', clientId: parseInt(clientId, 10), roleId: parseInt(roleId, 10), organizationId: parseInt(organizationId, 10) }
                };
                if (warehouseId !== undefined && warehouseId !== null) bodyParams.parameters.warehouseId = parseInt(warehouseId, 10);
                
                const resFinal = await httpsJsonRequest({ path: '/api/v1/auth/tokens', method: 'POST', body: bodyParams, serverType });
                loginLirion = { ok: !!resFinal.token, statusCode: 200, body: resFinal };
            } 
            // Si no se envían IDs (operadores en un paso o endpoints antiguos), hacemos la cadena de peticiones auto-select
            else {
                const resRaw = await httpsJsonRequest({ path: '/api/v1/auth/tokens', method: 'POST', body: { userName: username, password }, serverType });
                if (resRaw.token && resRaw.clients && resRaw.clients.length) {
                    const rawToken = resRaw.token;
                    const cid = resRaw.clients[0].id;
                    const resRoles = await httpsJsonRequest({ path: `/api/v1/auth/roles?client=${cid}`, method: 'GET', token: rawToken, serverType });
                    if (resRoles.roles && resRoles.roles.length) {
                        const rid = resRoles.roles[0].id;
                        const resOrgs = await httpsJsonRequest({ path: `/api/v1/auth/organizations?client=${cid}&role=${rid}`, method: 'GET', token: rawToken, serverType });
                        if (resOrgs.organizations && resOrgs.organizations.length) {
                            const oid = resOrgs.organizations[0].id;
                            const resWhs = await httpsJsonRequest({ path: `/api/v1/auth/warehouses?client=${cid}&role=${rid}&organization=${oid}`, method: 'GET', token: rawToken, serverType });
                            if (resWhs.warehouses && resWhs.warehouses.length) {
                                const wid = resWhs.warehouses[0].id;
                                const resFinal = await httpsJsonRequest({
                                    path: '/api/v1/auth/tokens', method: 'POST',
                                    body: { userName: username, password, parameters: { clientId: cid, roleId: rid, organizationId: oid, warehouseId: wid, language: 'es_CL' } },
                                    serverType
                                });
                                loginLirion = { ok: !!resFinal.token, statusCode: 200, body: resFinal };
                            }
                        }
                    }
                }
            }
        } catch (lirionErr) {
            console.error('Error contactando a Lirion durante el login, intentando fallback local:', lirionErr.message);
        }

        const isValidInLirion = loginLirion.ok;

        const lirionToken = extraerTokenLirion(loginLirion.body);
        const lirionAdUserIdDesdeToken = extraerAdUserIdDesdeRespuestaLirion(loginLirion.body);

        let localUser = null;

        if (isValidInLirion) {
            let lirionUser = await buscarUsuarioLirionPorUsername(poolIdempiere, username);

            // Algunos tokens REST devuelven directamente el AD_User_ID. Si viene en la respuesta,
            // lo usamos como respaldo para evitar caer en SuperUser por no encontrar ldapuser/value.
            if (!lirionUser && lirionAdUserIdDesdeToken) {
                const lirionResById = await poolIdempiere.query(`
                    SELECT ad_user_id, value, name, title, description, email, ldapuser
                    FROM adempiere.ad_user
                    WHERE ad_user_id = $1
                      AND isactive = 'Y'
                    LIMIT 1
                `, [lirionAdUserIdDesdeToken]);
                lirionUser = lirionResById.rows[0] || null;
            }

            if (lirionUser) {
                let rolAsignado = 'operador';

                const pistasRol = ((lirionUser.title || '') + ' ' + (lirionUser.description || '')).toLowerCase();

                if (pistasRol.includes('admin')) rolAsignado = 'admin';
                else if (pistasRol.includes('plan')) rolAsignado = 'planificacion';
                else if (pistasRol.includes('super')) rolAsignado = 'supervisor';
                else if (pistasRol.includes('calidad')) rolAsignado = 'calidad';

                localUser = await db.get('SELECT * FROM usuarios WHERE LOWER(username) = LOWER(?)', [username]);

                if (!localUser) {
                    await db.run(`
                        INSERT INTO usuarios (username, password, nombre, adempiere_user_id, rol, activo)
                        VALUES (?, ?, ?, ?, ?, 1)
                    `, [username, bcrypt.hashSync(password, 10), lirionUser.name, lirionUser.ad_user_id, rolAsignado]);

                    localUser = await db.get('SELECT * FROM usuarios WHERE LOWER(username) = LOWER(?)', [username]);
                } else {
                    await db.run(`
                        UPDATE usuarios
                        SET adempiere_user_id = ?, password = ?, nombre = ?
                        WHERE id = ?
                    `, [lirionUser.ad_user_id, bcrypt.hashSync(password, 10), lirionUser.name, localUser.id]);

                    localUser.adempiere_user_id = lirionUser.ad_user_id;
                    localUser.nombre = lirionUser.name;
                }
            } else {
                return res.status(401).json({ error: 'Usuario inactivo en Lirion' });
            }
        } else {
            localUser = await db.get('SELECT * FROM usuarios WHERE LOWER(username) = LOWER(?) AND activo = 1', [username]);

            if (!localUser) return res.status(401).json({ error: 'Usuario no encontrado' });

            const passwordMatch = (password === localUser.password) || bcrypt.compareSync(password, localUser.password);

            if (!passwordMatch) return res.status(401).json({ error: 'Contraseña incorrecta' });
        }

        const rolesPms = localUser.rol ? localUser.rol.split(',').map(r => r.trim()) : [];
        const primerRol = rolesPms.length > 0 ? rolesPms[0] : null;

        const token = jwt.sign({
            id: localUser.id,
            rol: localUser.rol,
            roles_pms: rolesPms,
            nombre: localUser.nombre,
            username: localUser.username,
            adempiere_user_id: localUser.adempiere_user_id,
            lirion_ad_user_id: lirionAdUserIdDesdeToken,
            lirion_token: lirionToken
        }, SECRET_KEY, { expiresIn: '8h' });

        res.json({
            token,
            rol: primerRol,
            roles_pms: rolesPms,
            nombre: localUser.nombre,
            id: localUser.id,
            adempiere_user_id: localUser.adempiere_user_id,
            lirion_auth: !!lirionToken
        });

    } catch (err) {
        console.error('❌ Error login:', err.message);
        res.status(500).json({ error: 'Error interno' });
    }
});

//Login Operadores
app.get('/api/auth/operadores', async (req, res) => {
    try {
        const operadores = await db.all(`
            SELECT 
                id,
                username,
                nombre,
                rol,
                activo
            FROM usuarios
            WHERE LOWER(rol) = 'operador'
              AND activo = 1
            ORDER BY nombre ASC, username ASC
        `);

        res.json(operadores.map(op => ({
            id: op.id,
            username: op.username,
            nombre: op.nombre || op.username,
            iniciales: String(op.nombre || op.username || 'OP')
                .trim()
                .split(/\\s+/)
                .slice(0, 2)
                .map(p => p[0])
                .join('')
                .toUpperCase()
        })));
    } catch (err) {
        console.error('❌ Error cargando operadores:', err.message);
        res.status(500).json({ error: err.message });
    }
});


app.get('/api/admin/usuarios', async (req, res) => {
    try { const usuarios = await db.all('SELECT id, username, nombre, rol, activo FROM usuarios'); res.json(usuarios); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/usuarios', async (req, res) => {
    const { username, password, nombre, rol } = req.body;
    try {
        await db.run('INSERT INTO usuarios (username, password, nombre, rol) VALUES (?, ?, ?, ?)', [username, bcrypt.hashSync(password, 10), nombre, rol]);
        res.json({ message: 'Usuario creado' });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/admin/usuarios/:id', async (req, res) => {
    const { nombre, username, rol, password } = req.body;
    try {
        if (password && password.trim() !== "") {
            await db.run('UPDATE usuarios SET nombre = ?, username = ?, rol = ?, password = ? WHERE id = ?', [nombre, username, rol, bcrypt.hashSync(password, 10), req.params.id]);
        } else {
            await db.run('UPDATE usuarios SET nombre = ?, username = ?, rol = ? WHERE id = ?', [nombre, username, rol, req.params.id]);
        }
        res.json({ message: 'Usuario actualizado' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/usuarios/:id/estado', async (req, res) => {
    try {
        await db.run('UPDATE usuarios SET activo = ? WHERE id = ?', [req.body.activo, req.params.id]);
        res.json({ message: 'Estado actualizado' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Cerrando servidor de forma segura...');
    try {
        if (poolIdempiere) await poolIdempiere.end();
        if (db && db.pool) await db.pool.end();
        process.exit(0);
    } catch (err) { process.exit(1); }
});


// ==========================================
// VALIDAR OP SOLO CONTRA LIRION / iDEMPIERE
// Tabla: adempiere.m_production
// Campo visible en Lirion: documentno
// ==========================================
app.get('/api/idempiere/verificar-op/:op', async (req, res) => {
    const opOriginal = String(req.params.op || '').trim();

    if (!opOriginal) {
        return res.json({ existe: false, origen: 'lirion', op: '' });
    }

    try {
        const result = await poolIdempiere.query(`
            SELECT
                m_production_id,
                ad_client_id,
                ad_org_id,
                documentno,
                name,
                docstatus,
                processed,
                isactive,
                created
            FROM adempiere.m_production
            WHERE regexp_replace(UPPER(TRIM(documentno)), '[^A-Z0-9]', '', 'g') =
                  regexp_replace(UPPER(TRIM($1)), '[^A-Z0-9]', '', 'g')
            ORDER BY created DESC
            LIMIT 1
        `, [opOriginal]);

        if (result.rows.length > 0) {
            return res.json({
                existe: true,
                origen: 'lirion',
                op_buscada: opOriginal,
                op_encontrada: result.rows[0].documentno,
                op: result.rows[0].documentno,
                m_production_id: result.rows[0].m_production_id,
                ad_client_id: result.rows[0].ad_client_id,
                ad_org_id: result.rows[0].ad_org_id,
                name: result.rows[0].name,
                docstatus: result.rows[0].docstatus,
                processed: result.rows[0].processed,
                isactive: result.rows[0].isactive,
                created: result.rows[0].created
            });
        }

        return res.json({ existe: false, origen: 'lirion', op: opOriginal });
    } catch (err) {
        console.error('❌ Error verificando OP en Lirion:', err.message);
        res.status(500).json({ error: 'Error al verificar OP en Lirion', detalle: err.message });
    }
});
