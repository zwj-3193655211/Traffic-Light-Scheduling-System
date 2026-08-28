import mysql from 'mysql2/promise'
import 'dotenv/config'

const DB_NAME = process.env.DB_NAME || 'traffic_light_system'

// 建库阶段用的连接串（尚未指定 database）
const baseConnection = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
}

// 创建数据库连接池
const pool = mysql.createPool({
    ...baseConnection,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
});

// 测试数据库连接
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('数据库连接成功');
        connection.release();
        return true;
    } catch (error) {
        console.error('数据库连接失败:', error);
        return false;
    }
}

// 初始化数据库表
async function initializeDatabase() {
    try {
        // 创建数据库（如果不存在）
        const createDbSQL = `
            CREATE DATABASE IF NOT EXISTS ${DB_NAME}
            CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `;

        const tempPool = mysql.createPool(baseConnection);

        await tempPool.execute(createDbSQL);
        await tempPool.end();

        await createTables();
        await ensureSchema();
        console.log('数据库初始化完成');
        return true;
    } catch (error) {
        console.error('数据库初始化失败:', error);
        return false;
    }
}

// 创建数据表
async function createTables() {
    const createIntersectionsTable = `
        CREATE TABLE IF NOT EXISTS intersections (
            id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            latitude DECIMAL(10, 8) NOT NULL,
            longitude DECIMAL(11, 8) NOT NULL,
            status TINYINT DEFAULT 1 COMMENT '1-正常, 0-维护中',
            auto_mode TINYINT DEFAULT 1 COMMENT '1-自动, 0-手动',
            current_phase TINYINT DEFAULT 1,
            cycle_length INT DEFAULT 120,
            next_north_id INT NULL,
            next_south_id INT NULL,
            next_east_id INT NULL,
            next_west_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status (status),
            INDEX idx_location (latitude, longitude),
            INDEX idx_next_north (next_north_id),
            INDEX idx_next_south (next_south_id),
            INDEX idx_next_east (next_east_id),
            INDEX idx_next_west (next_west_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createTrafficLightsTable = `
        CREATE TABLE IF NOT EXISTS traffic_lights (
            id INT PRIMARY KEY AUTO_INCREMENT,
            intersection_id INT NOT NULL,
            direction VARCHAR(20) NOT NULL COMMENT 'N/S/E/W',
            movement_type VARCHAR(10) NOT NULL DEFAULT 'straight' COMMENT 'straight/left',
            phase_number TINYINT NOT NULL COMMENT '相位号',
            current_status TINYINT DEFAULT 0 COMMENT '0-红, 1-黄, 2-绿',
            default_green_time INT DEFAULT 30,
            default_red_time INT DEFAULT 30,
            default_yellow_time INT DEFAULT 3,
            remaining_time INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (intersection_id) REFERENCES intersections(id) ON DELETE CASCADE,
            INDEX idx_intersection (intersection_id),
            INDEX idx_status (current_status),
            UNIQUE KEY uniq_light (intersection_id, direction, movement_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createVehicleFlowsTable = `
        CREATE TABLE IF NOT EXISTS vehicle_flows (
            id INT PRIMARY KEY AUTO_INCREMENT,
            intersection_id INT NOT NULL,
            direction VARCHAR(20) NOT NULL,
            vehicle_count INT NOT NULL,
            average_speed DECIMAL(5,2) DEFAULT 0.00,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (intersection_id) REFERENCES intersections(id) ON DELETE CASCADE,
            INDEX idx_intersection_time (intersection_id, timestamp),
            INDEX idx_timestamp (timestamp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createLightTimingsTable = `
        CREATE TABLE IF NOT EXISTS light_timings (
            id INT PRIMARY KEY AUTO_INCREMENT,
            traffic_light_id INT NOT NULL,
            green_time INT NOT NULL,
            red_time INT NOT NULL,
            yellow_time INT NOT NULL DEFAULT 3,
            timing_type VARCHAR(20) DEFAULT 'dynamic' COMMENT 'static/dynamic/emergency',
            effective_from TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (traffic_light_id) REFERENCES traffic_lights(id) ON DELETE CASCADE,
            INDEX idx_traffic_light (traffic_light_id),
            INDEX idx_effective_time (effective_from)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

  const createEmergencyVehiclesTable = `
        CREATE TABLE IF NOT EXISTS emergency_vehicles (
            id INT PRIMARY KEY AUTO_INCREMENT,
            intersection_id INT NOT NULL,
            vehicle_type VARCHAR(50) NOT NULL COMMENT '救护车/消防车/警车',
            vehicle_id VARCHAR(50) NOT NULL,
            latitude DECIMAL(10, 8) NOT NULL,
            longitude DECIMAL(11, 8) NOT NULL,
            priority_level TINYINT DEFAULT 1 COMMENT '1-5, 5最高',
            estimated_arrival TIMESTAMP,
            status TINYINT DEFAULT 0 COMMENT '0-等待, 1-已通过',
            direction VARCHAR(20) NOT NULL DEFAULT 'North',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (intersection_id) REFERENCES intersections(id) ON DELETE CASCADE,
            INDEX idx_intersection (intersection_id),
            INDEX idx_status (status),
            INDEX idx_arrival_time (estimated_arrival)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createSystemSettingsTable = `
        CREATE TABLE IF NOT EXISTS system_settings (
            id INT PRIMARY KEY AUTO_INCREMENT,
            system_name VARCHAR(100) NOT NULL,
            auto_mode TINYINT DEFAULT 1,
            emergency_priority TINYINT DEFAULT 1,
            max_cycle_length INT DEFAULT 180,
            min_cycle_length INT DEFAULT 60,
            yellow_light_duration INT DEFAULT 3,
            detection_radius INT DEFAULT 100,
            update_interval INT DEFAULT 5,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createIntersectionParamsTable = `
        CREATE TABLE IF NOT EXISTS intersection_params (
            intersection_id INT PRIMARY KEY,
            window_seconds INT DEFAULT 10,
            low_flow_threshold INT DEFAULT 15,
            min_green_floor INT DEFAULT 10,
            arrival_straight_scale DECIMAL(5,2) DEFAULT 0.30,
            arrival_left_scale DECIMAL(5,2) DEFAULT 0.20,
            release_straight_scale DECIMAL(5,2) DEFAULT 0.80,
            release_left_scale DECIMAL(5,2) DEFAULT 0.70,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (intersection_id) REFERENCES intersections(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createUsersTable = `
        CREATE TABLE IF NOT EXISTS users (
            id INT PRIMARY KEY AUTO_INCREMENT,
            username VARCHAR(64) NOT NULL,
            password_salt VARBINARY(16) NOT NULL,
            password_hash VARBINARY(64) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_username (username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    const createSessionsTable = `
        CREATE TABLE IF NOT EXISTS sessions (
            token VARCHAR(128) PRIMARY KEY,
            user_id INT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_user (user_id),
            INDEX idx_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

    try {
        await pool.execute(createIntersectionsTable);
        await pool.execute(createTrafficLightsTable);
        await pool.execute(createVehicleFlowsTable);
        await pool.execute(createLightTimingsTable);
        await pool.execute(createEmergencyVehiclesTable);
        await pool.execute(createSystemSettingsTable);
        await pool.execute(createIntersectionParamsTable);
        await pool.execute(createUsersTable);
        await pool.execute(createSessionsTable);
        
        console.log('所有数据表创建成功');
        return true;
    } catch (error) {
        console.error('创建数据表失败:', error);
        return false;
    }
}

async function ensureSchema() {
    try {
        const dbName = DB_NAME;
        // emergency_vehicles: add direction column if missing
        const [dirCols] = await pool.execute(
            `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'emergency_vehicles' AND COLUMN_NAME = 'direction'`,
            [dbName]
        );
        if (!Array.isArray(dirCols) || dirCols.length === 0) {
            await pool.execute(`ALTER TABLE emergency_vehicles ADD COLUMN direction VARCHAR(20) NOT NULL DEFAULT 'North'`);
        }

        // emergency_vehicles: add updated_at column if missing
        const [updCols] = await pool.execute(
            `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'emergency_vehicles' AND COLUMN_NAME = 'updated_at'`,
            [dbName]
        );
        if (!Array.isArray(updCols) || updCols.length === 0) {
            await pool.execute(`ALTER TABLE emergency_vehicles ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL`);
            // ensure default on update current timestamp
            await pool.execute(`ALTER TABLE emergency_vehicles MODIFY COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
        }

        // intersections: add auto_mode/current_phase/cycle_length if missing
        const needCols = [
            { name: 'auto_mode', ddl: `ALTER TABLE intersections ADD COLUMN auto_mode TINYINT DEFAULT 1` },
            { name: 'current_phase', ddl: `ALTER TABLE intersections ADD COLUMN current_phase TINYINT DEFAULT 1` },
            { name: 'cycle_length', ddl: `ALTER TABLE intersections ADD COLUMN cycle_length INT DEFAULT 120` },
            { name: 'next_north_id', ddl: `ALTER TABLE intersections ADD COLUMN next_north_id INT NULL` },
            { name: 'next_south_id', ddl: `ALTER TABLE intersections ADD COLUMN next_south_id INT NULL` },
            { name: 'next_east_id', ddl: `ALTER TABLE intersections ADD COLUMN next_east_id INT NULL` },
            { name: 'next_west_id', ddl: `ALTER TABLE intersections ADD COLUMN next_west_id INT NULL` },
        ];
        for (const col of needCols) {
            const [rows] = await pool.execute(
                `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'intersections' AND COLUMN_NAME = ?`,
                [dbName, col.name]
            );
            if (!Array.isArray(rows) || rows.length === 0) {
                await pool.execute(col.ddl);
            }
        }

        // add indexes for next_* columns if missing
        const nextIdx = [
            { name: 'idx_next_north', col: 'next_north_id' },
            { name: 'idx_next_south', col: 'next_south_id' },
            { name: 'idx_next_east', col: 'next_east_id' },
            { name: 'idx_next_west', col: 'next_west_id' },
        ];
        for (const idx of nextIdx) {
            const [rows] = await pool.execute(
                `SELECT INDEX_NAME FROM information_schema.statistics WHERE table_schema = ? AND table_name = 'intersections' AND INDEX_NAME = ?`,
                [dbName, idx.name]
            );
            if (!Array.isArray(rows) || rows.length === 0) {
                await pool.execute(`ALTER TABLE intersections ADD INDEX ${idx.name} (${idx.col})`);
            }
        }

        // add foreign keys (best-effort)
        try {
            await pool.execute(`ALTER TABLE intersections ADD CONSTRAINT fk_next_north FOREIGN KEY (next_north_id) REFERENCES intersections(id) ON DELETE SET NULL`);
        } catch {}
        try {
            await pool.execute(`ALTER TABLE intersections ADD CONSTRAINT fk_next_south FOREIGN KEY (next_south_id) REFERENCES intersections(id) ON DELETE SET NULL`);
        } catch {}
        try {
            await pool.execute(`ALTER TABLE intersections ADD CONSTRAINT fk_next_east FOREIGN KEY (next_east_id) REFERENCES intersections(id) ON DELETE SET NULL`);
        } catch {}
        try {
            await pool.execute(`ALTER TABLE intersections ADD CONSTRAINT fk_next_west FOREIGN KEY (next_west_id) REFERENCES intersections(id) ON DELETE SET NULL`);
        } catch {}

        // traffic_lights: add movement_type column if missing
        const [movementTypeCol] = await pool.execute(
            `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'traffic_lights' AND COLUMN_NAME = 'movement_type'`,
            [dbName]
        );
        if (!Array.isArray(movementTypeCol) || movementTypeCol.length === 0) {
            await pool.execute(`ALTER TABLE traffic_lights ADD COLUMN movement_type VARCHAR(10) NOT NULL DEFAULT 'straight' COMMENT 'straight/left' AFTER direction`);
        }

        // update existing traffic lights to have both straight and left entries
        const [existingLights] = await pool.execute(`SELECT intersection_id, direction FROM traffic_lights GROUP BY intersection_id, direction HAVING COUNT(*) = 1`);
        if (Array.isArray(existingLights) && existingLights.length > 0) {
            for (const light of existingLights) {
                const [current] = await pool.execute(`SELECT * FROM traffic_lights WHERE intersection_id = ? AND direction = ?`, [light.intersection_id, light.direction]);
                if (current.length > 0) {
                    const l = current[0];
                    const leftPhase = (l.direction === 'East' || l.direction === 'West') ? 2 : 4;
                    await pool.execute(
                        `INSERT IGNORE INTO traffic_lights (intersection_id, direction, movement_type, phase_number, current_status, default_green_time, default_red_time, default_yellow_time, remaining_time, created_at) VALUES (?, ?, 'left', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                        [light.intersection_id, light.direction, leftPhase, 0, l.default_green_time, l.default_red_time, l.default_yellow_time, 0]
                    );
                }
            }
        }

        await pool.execute(
            `UPDATE traffic_lights
             SET phase_number = CASE
               WHEN direction IN ('East','West') AND movement_type = 'straight' THEN 1
               WHEN direction IN ('East','West') AND movement_type = 'left' THEN 2
               WHEN direction IN ('North','South') AND movement_type = 'straight' THEN 3
               WHEN direction IN ('North','South') AND movement_type = 'left' THEN 4
               ELSE phase_number
             END`
        );

        try {
            const [mgCols] = await pool.execute(
                `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'intersection_params' AND COLUMN_NAME = 'min_green_floor'`,
                [dbName]
            );
            if (Array.isArray(mgCols) && mgCols.length > 0) {
                await pool.execute(`ALTER TABLE intersection_params MODIFY COLUMN min_green_floor INT DEFAULT 10`);
            }
        } catch {}

        try {
            const [lfCols] = await pool.execute(
                `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'intersection_params' AND COLUMN_NAME = 'low_flow_threshold'`,
                [dbName]
            );
            if (Array.isArray(lfCols) && lfCols.length > 0) {
                await pool.execute(`ALTER TABLE intersection_params MODIFY COLUMN low_flow_threshold INT DEFAULT 15`);
                // 更新现有数据，将默认值 5 升级为 15
                await pool.execute(`UPDATE intersection_params SET low_flow_threshold = 15 WHERE low_flow_threshold = 5`);
            }
        } catch {}

        try {
            const scaleCols = [
                { name: 'arrival_straight_scale', ddl: `ALTER TABLE intersection_params ADD COLUMN arrival_straight_scale DECIMAL(5,2) DEFAULT 0.30` },
                { name: 'arrival_left_scale', ddl: `ALTER TABLE intersection_params ADD COLUMN arrival_left_scale DECIMAL(5,2) DEFAULT 0.20` },
                { name: 'release_straight_scale', ddl: `ALTER TABLE intersection_params ADD COLUMN release_straight_scale DECIMAL(5,2) DEFAULT 0.80` },
                { name: 'release_left_scale', ddl: `ALTER TABLE intersection_params ADD COLUMN release_left_scale DECIMAL(5,2) DEFAULT 0.70` },
            ];
            for (const col of scaleCols) {
                const [rows] = await pool.execute(
                    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'intersection_params' AND COLUMN_NAME = ?`,
                    [dbName, col.name]
                );
                if (!Array.isArray(rows) || rows.length === 0) {
                    await pool.execute(col.ddl);
                }
            }
        } catch {}

        return true;
    } catch (error) {
        console.error('校验/更新表结构失败:', error);
        return false;
    }
}

export { pool, testConnection, initializeDatabase, createTables, ensureSchema }
