const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { setCache, getCache, deleteCache } = require('../config/redis');

// 获取系统设置
router.get('/', async (req, res) => {
    try {
        const cacheKey = 'system:settings';
        
        // 尝试从缓存获取
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.json({
                success: true,
                data: cachedData,
                fromCache: true
            });
        }
        
        // 从数据库获取
        const [rows] = await pool.execute('SELECT * FROM system_settings ORDER BY id DESC LIMIT 1');
        
        if (rows.length === 0) {
            // 如果没有设置，创建默认设置
            const defaultSettings = {
                system_name: '智能交通管理系统',
                auto_mode: true,
                emergency_priority: true,
                max_cycle_length: 180,
                min_cycle_length: 60,
                yellow_light_duration: 3,
                detection_radius: 100,
                update_interval: 5
            };
            
            const [result] = await pool.execute(
                `INSERT INTO system_settings (system_name, auto_mode, emergency_priority, max_cycle_length, 
                 min_cycle_length, yellow_light_duration, detection_radius, update_interval) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    defaultSettings.system_name,
                    defaultSettings.auto_mode,
                    defaultSettings.emergency_priority,
                    defaultSettings.max_cycle_length,
                    defaultSettings.min_cycle_length,
                    defaultSettings.yellow_light_duration,
                    defaultSettings.detection_radius,
                    defaultSettings.update_interval
                ]
            );
            
            defaultSettings.id = result.insertId;
            defaultSettings.created_at = new Date();
            defaultSettings.updated_at = new Date();
            
            // 缓存结果（1小时）
            await setCache(cacheKey, defaultSettings, 3600);
            
            return res.json({
                success: true,
                data: defaultSettings,
                fromCache: false
            });
        }
        
        const settings = rows[0];
        
        // 缓存结果（1小时）
        await setCache(cacheKey, settings, 3600);
        
        res.json({
            success: true,
            data: settings,
            fromCache: false
        });
    } catch (error) {
        console.error('获取系统设置失败:', error);
        res.status(500).json({
            success: false,
            message: '获取系统设置失败',
            error: error.message
        });
    }
});

// 更新系统设置
router.put('/', async (req, res) => {
    try {
        const {
            system_name,
            auto_mode,
            emergency_priority,
            max_cycle_length,
            min_cycle_length,
            yellow_light_duration,
            detection_radius,
            update_interval
        } = req.body;
        
        // 验证输入
        if (!system_name || max_cycle_length < min_cycle_length) {
            return res.status(400).json({
                success: false,
                message: '参数验证失败'
            });
        }
        
        // 获取当前设置
        const [currentRows] = await pool.execute('SELECT id FROM system_settings ORDER BY id DESC LIMIT 1');
        
        if (currentRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '系统设置不存在'
            });
        }
        
        const settingsId = currentRows[0].id;
        
        // 更新设置
        await pool.execute(
            `UPDATE system_settings SET 
             system_name = ?, auto_mode = ?, emergency_priority = ?, max_cycle_length = ?, 
             min_cycle_length = ?, yellow_light_duration = ?, detection_radius = ?, 
             update_interval = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [
                system_name,
                auto_mode,
                emergency_priority,
                max_cycle_length,
                min_cycle_length,
                yellow_light_duration,
                detection_radius,
                update_interval,
                settingsId
            ]
        );
        
        // 获取更新后的设置
        const [updatedRows] = await pool.execute('SELECT * FROM system_settings WHERE id = ?', [settingsId]);
        const updatedSettings = updatedRows[0];
        
        // 清除缓存
            await deleteCache('system:settings');
        
        res.json({
            success: true,
            message: '系统设置更新成功',
            data: updatedSettings
        });
    } catch (error) {
        console.error('更新系统设置失败:', error);
        res.status(500).json({
            success: false,
            message: '更新系统设置失败',
            error: error.message
        });
    }
});

// 重置系统设置为默认值
router.post('/reset', async (req, res) => {
    try {
        // 获取当前设置ID
        const [currentRows] = await pool.execute('SELECT id FROM system_settings ORDER BY id DESC LIMIT 1');
        
        if (currentRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '系统设置不存在'
            });
        }
        
        const settingsId = currentRows[0].id;
        
        // 默认设置
        const defaultSettings = {
            system_name: '智能交通管理系统',
            auto_mode: true,
            emergency_priority: true,
            max_cycle_length: 180,
            min_cycle_length: 60,
            yellow_light_duration: 3,
            detection_radius: 100,
            update_interval: 5
        };
        
        // 重置为默认值
        await pool.execute(
            `UPDATE system_settings SET 
             system_name = ?, auto_mode = ?, emergency_priority = ?, max_cycle_length = ?, 
             min_cycle_length = ?, yellow_light_duration = ?, detection_radius = ?, 
             update_interval = ?, updated_at = CURRENT_TIMESTAMP 
             WHERE id = ?`,
            [
                defaultSettings.system_name,
                defaultSettings.auto_mode,
                defaultSettings.emergency_priority,
                defaultSettings.max_cycle_length,
                defaultSettings.min_cycle_length,
                defaultSettings.yellow_light_duration,
                defaultSettings.detection_radius,
                defaultSettings.update_interval,
                settingsId
            ]
        );
        
        // 获取重置后的设置
        const [resetRows] = await pool.execute('SELECT * FROM system_settings WHERE id = ?', [settingsId]);
        const resetSettings = resetRows[0];
        
        // 清除缓存
        await deleteCache('system:settings');
        
        res.json({
            success: true,
            message: '系统设置已重置为默认值',
            data: resetSettings
        });
    } catch (error) {
        console.error('重置系统设置失败:', error);
        res.status(500).json({
            success: false,
            message: '重置系统设置失败',
            error: error.message
        });
    }
});

router.get('/ai-mode', async (req, res) => {
    try {
        const flag = await getCache('system:ai_mode');
        res.json({ success: true, data: String(flag ?? '') === '1' });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取AI模式失败', error: error.message });
    }
});

router.post('/ai-mode', async (req, res) => {
    try {
        const { enabled } = req.body;
        await setCache('system:ai_mode', enabled ? '1' : '0', 24 * 3600);
        // 通知所有页面（Dashboard / TrafficControl / Demo）AI 开关状态变化
        try {
            const { publishMessage } = require('../config/redis');
            await publishMessage('settings:ai_mode_changed', { enabled: !!enabled, ts: Date.now() });
        } catch {}
        res.json({ success: true, message: 'AI模式已更新', data: !!enabled });
    } catch (error) {
        res.status(500).json({ success: false, message: '更新AI模式失败', error: error.message });
    }
});

// 运行时热切换 AI 模型（见 docs/AI优化设计.md 5.1）：写入 Redis system:ai_model，
// server 的 AI 循环每个 tick 读取并调用 advisor.setModelOverride，亦通过广播即时生效。
router.get('/ai-model', async (req, res) => {
    try {
        const m = await getCache('system:ai_model');
        res.json({ success: true, data: m ? String(m) : '' });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取AI模型失败', error: error.message });
    }
});

router.post('/ai-model', async (req, res) => {
    try {
        const { model } = req.body;
        if (!model || !String(model).trim()) {
            return res.status(400).json({ success: false, message: 'model 不能为空' });
        }
        const m = String(model).trim();
        await setCache('system:ai_model', m, 24 * 3600);
        try {
            const { publishMessage } = require('../config/redis');
            await publishMessage('settings:ai_model_changed', { model: m, ts: Date.now() });
        } catch {}
        res.json({ success: true, message: 'AI模型已更新', data: m });
    } catch (error) {
        res.status(500).json({ success: false, message: '更新AI模型失败', error: error.message });
    }
});

// 设置选中的路口ID (用于AI只处理特定路口)
router.post('/selected-intersection', async (req, res) => {
    try {
        const { intersectionId } = req.body;
        const id = intersectionId ? parseInt(intersectionId) : 0;
        if (!id) {
            await setCache('system:selected_intersection', '0', 86400);
            res.json({ success: true, data: 0 });
            return;
        }

        const [rows] = await pool.execute(`SELECT status FROM intersections WHERE id = ? LIMIT 1`, [id]);
        if (!Array.isArray(rows) || rows.length === 0) {
            await setCache('system:selected_intersection', '0', 86400);
            res.status(400).json({ success: false, message: '路口不存在', data: 0 });
            return;
        }
        const status = Number(rows[0]?.status ?? 0);
        if (status !== 1) {
            await setCache('system:selected_intersection', '0', 86400);
            res.status(400).json({ success: false, message: '路口维护中，不可选择', data: 0 });
            return;
        }

        await setCache('system:selected_intersection', String(id), 86400);
        
        res.json({
            success: true,
            data: id
        });
    } catch (error) {
        console.error('更新选中路口失败:', error);
        res.status(500).json({
            success: false,
            message: '更新选中路口失败',
            error: error.message
        });
    }
});

router.get('/selected-intersection', async (req, res) => {
    try {
        const id = await getCache('system:selected_intersection');
        res.json({ success: true, data: id ? parseInt(id) : 0 });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取选中路口失败', error: error.message });
    }
});

router.get('/intersection-params/:intersectionId', async (req, res) => {
    try {
        const intersectionId = parseInt(req.params.intersectionId);
        if (!intersectionId) {
            return res.status(400).json({ success: false, message: 'intersectionId invalid' });
        }
        const [rows] = await pool.execute(
            `SELECT intersection_id, window_seconds, low_flow_threshold, min_green_floor,
                    arrival_straight_scale, arrival_left_scale, release_straight_scale, release_left_scale
             FROM intersection_params WHERE intersection_id = ?`,
            [intersectionId]
        );
        if (!Array.isArray(rows) || rows.length === 0) {
            await pool.execute(
                `INSERT IGNORE INTO intersection_params (intersection_id) VALUES (?)`,
                [intersectionId]
            );
            const [rows2] = await pool.execute(
                `SELECT intersection_id, window_seconds, low_flow_threshold, min_green_floor,
                        arrival_straight_scale, arrival_left_scale, release_straight_scale, release_left_scale
                 FROM intersection_params WHERE intersection_id = ?`,
                [intersectionId]
            );
            return res.json({ success: true, data: rows2[0] });
        }
        res.json({ success: true, data: rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取路口参数失败', error: error.message });
    }
});

router.put('/intersection-params/:intersectionId', async (req, res) => {
    try {
        const intersectionId = parseInt(req.params.intersectionId);
        if (!intersectionId) {
            return res.status(400).json({ success: false, message: 'intersectionId invalid' });
        }
        const { window_seconds, low_flow_threshold, min_green_floor,
            arrival_straight_scale, arrival_left_scale, release_straight_scale, release_left_scale } = req.body || {};
        const windowSeconds = window_seconds != null ? parseInt(window_seconds) : null;
        const lowFlowThreshold = low_flow_threshold != null ? parseInt(low_flow_threshold) : null;
        const minGreenFloor = min_green_floor != null ? parseInt(min_green_floor) : null;
        const arrivalStraightScale = arrival_straight_scale != null ? parseFloat(arrival_straight_scale) : null;
        const arrivalLeftScale = arrival_left_scale != null ? parseFloat(arrival_left_scale) : null;
        const releaseStraightScale = release_straight_scale != null ? parseFloat(release_straight_scale) : null;
        const releaseLeftScale = release_left_scale != null ? parseFloat(release_left_scale) : null;

        await pool.execute(
            `INSERT INTO intersection_params (
                intersection_id, window_seconds, low_flow_threshold, min_green_floor,
                arrival_straight_scale, arrival_left_scale, release_straight_scale, release_left_scale
             )
             VALUES (
                ?,
                COALESCE(?, DEFAULT(window_seconds)),
                COALESCE(?, DEFAULT(low_flow_threshold)),
                COALESCE(?, DEFAULT(min_green_floor)),
                COALESCE(?, DEFAULT(arrival_straight_scale)),
                COALESCE(?, DEFAULT(arrival_left_scale)),
                COALESCE(?, DEFAULT(release_straight_scale)),
                COALESCE(?, DEFAULT(release_left_scale))
             )
             ON DUPLICATE KEY UPDATE
               window_seconds = COALESCE(VALUES(window_seconds), window_seconds),
               low_flow_threshold = COALESCE(VALUES(low_flow_threshold), low_flow_threshold),
               min_green_floor = COALESCE(VALUES(min_green_floor), min_green_floor),
               arrival_straight_scale = COALESCE(VALUES(arrival_straight_scale), arrival_straight_scale),
               arrival_left_scale = COALESCE(VALUES(arrival_left_scale), arrival_left_scale),
               release_straight_scale = COALESCE(VALUES(release_straight_scale), release_straight_scale),
               release_left_scale = COALESCE(VALUES(release_left_scale), release_left_scale),
               updated_at = CURRENT_TIMESTAMP`,
            [intersectionId, windowSeconds, lowFlowThreshold, minGreenFloor, arrivalStraightScale, arrivalLeftScale, releaseStraightScale, releaseLeftScale]
        );
        const [rows] = await pool.execute(
            `SELECT intersection_id, window_seconds, low_flow_threshold, min_green_floor,
                    arrival_straight_scale, arrival_left_scale, release_straight_scale, release_left_scale
             FROM intersection_params WHERE intersection_id = ?`,
            [intersectionId]
        );
        res.json({ success: true, data: rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: '更新路口参数失败', error: error.message });
    }
});

module.exports = router;
