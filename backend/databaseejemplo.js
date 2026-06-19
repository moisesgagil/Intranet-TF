const mysql = require("mysql2/promise");

async function setupDatabase(poolLirion) {
    const pool = mysql.createPool({
        host: "192.168.3.254",
        user: "sysop",
        password: "fewlikeme123!",
        database: "intranet-tf",
        waitForConnections: true,
        connectionLimit: 15,
        queueLimit: 0,
    });

    // 2. Objeto Wrapper para mantener compatibilidad absoluta con los endpoints actuales
    const dbWrapper = {
        pool: pool,
        query: async (sql, params) => pool.query(sql, params),

        // Emula db.get() -> Retorna una única fila o null
        get: async (sql, params) => {
            const [rows] = await pool.query(sql, params);
            return rows[0] || null;
        },

        // Emula db.all() -> Retorna un array con todas las filas
        all: async (sql, params) => {
            const [rows] = await pool.query(sql, params);
            return rows;
        },

        run: async (sql, params) => {
            // Manejo de transacciones nativas si vienen explícitas en texto
            if (sql.trim().toUpperCase() === "BEGIN TRANSACTION") {
                const connection = await pool.getConnection();
                await connection.beginTransaction();
                return connection;
            }

            const [result] = await pool.query(sql, params);
            return {
                lastID: result.insertId,
                changes: result.affectedRows,
            };
        },
    };

    // 3. --- SINCRONIZACIÓN DINÁMICA DE RECURSOS (Lirion -> MySQL) ---
    if (poolLirion) {
        try {
            const resLirion = await poolLirion.query(`
                SELECT a_asset_id, value, name 
                FROM adempiere.a_asset 
                WHERE isactive = 'Y' 
                AND a_asset_group_id IN (1000028, 1000043)
            `);

            for (const asset of resLirion.rows) {
                await dbWrapper.pool.query(
                    `
                    INSERT INTO maquinas (a_asset_id, codigo, nombre) 
                    VALUES (?, ?, ?)
                    ON DUPLICATE KEY UPDATE 
                        codigo = VALUES(codigo),
                        nombre = VALUES(nombre)
                `,
                    [asset.a_asset_id, asset.value, asset.name],
                );
            }
            console.log(
                "✅ Recursos de A_Asset (Lirion) sincronizados correctamente en MySQL.",
            );
        } catch (err) {
            console.error("❌ Error al sincronizar con A_Asset:", err.message);
        }
    }

    // 4. --- USUARIOS INICIALES DE CONTROL ---
    try {
        await dbWrapper.pool.query(`
            INSERT IGNORE INTO usuarios (username, password, nombre, rol) 
            VALUES ('admin', 'admin123', 'Administrador Sistema', 'admin')
        `);

        await dbWrapper.pool.query(`
            INSERT IGNORE INTO usuarios (username, password, nombre, rol) 
            VALUES ('plan', 'plan123', 'Planificación Techfoods', 'planificacion')
        `);
    } catch (err) {
        console.error("❌ Error al verificar usuarios base:", err.message);
    }

    return dbWrapper;
}

module.exports = { setupDatabase };