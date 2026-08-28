import express from 'express';
const router = express.Router();
import { pool } from '../config/database.js';
import { setCache, getCache, publishMessage } from '../config/redis.js';

// 获取路口的红绿灯状态
router.get('/intersection/:intersectionId', async (req, res) => {
    try {
        const { intersectionId } = req.params;
        const cacheKey = `traffic_lights:${intersectionId}`;
        
        // 尝试从缓存获取
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.json({
                success: true,
                data: cachedData,
                fromCache: true
            });
        }
        
        const [rows] = await pool.execute(`
            SELECT 
                tl.id,
                tl.intersection_id,
                tl.direction,
                tl.movement_type,
                tl.phase_number,
                tl.current_status,
                tl.default_green_time,
                tl.default_red_time,
                tl.default_yellow_time,
                tl.remaining_time,
                tl.created_at,
                tl.updated_at
            FROM traffic_lights tl
            WHERE tl.intersection_id = ?
            ORDER BY tl.phase_number, tl.direction, tl.movement_type
        `, [intersectionId]);
        
        // 缓存结果（30秒）
        await setCache(cacheKey, rows, 30);
        
        res.json({
            success: true,
            data: rows,
            fromCache: false
        });
    } catch (error) {
        console.error('获取红绿灯状态失败:', error);
        res.status(500).json({
            success: false,
            message: '获取红绿灯状态失败',
            error: error.message
        });
    }
});

// 手动控制红绿灯
router.post('/control', async (req, res) => {
    try {
        const { intersectionId, lightId, action, duration = 30 } = req.body;
        
        if (!intersectionId || !lightId || !action) {
            return res.status(400).json({
                success: false,
                message: '缺少必要参数'
            });
        }
        
        // 验证操作类型
        const validActions = ['switch_green', 'switch_red', 'switch_yellow'];
        if (!validActions.includes(action)) {
            return res.status(400).json({
                success: false,
                message: '无效的操作类型'
            });
        }
        
        // 获取当前红绿灯状态
        const [currentLight] = await pool.execute(`
            SELECT id, current_status, direction
            FROM traffic_lights
            WHERE id = ? AND intersection_id = ?
        `, [lightId, intersectionId]);
        
        if (currentLight.length === 0) {
            return res.status(404).json({
                success: false,
                message: '红绿灯不存在'
            });
        }
        
        let newStatus;
        let newRemainingTime = duration;
        
        switch (action) {
            case 'switch_green':
                newStatus = 2; // 绿灯
                break;
            case 'switch_red':
                newStatus = 0; // 红灯
                break;
            case 'switch_yellow':
                newStatus = 1; // 黄灯
                newRemainingTime = 3; // 黄灯固定3秒
                break;
        }
        
        // 更新红绿灯状态
        await pool.execute(`
            UPDATE traffic_lights 
            SET current_status = ?, remaining_time = ?, updated_at = NOW()
            WHERE id = ?
        `, [newStatus, newRemainingTime, lightId]);
        
        // 记录时序变更
        const greenTime = newStatus === 2 ? duration : 0;
        const redTime = newStatus === 0 ? duration : 0;
        const yellowTime = newStatus === 1 ? 3 : 0;
        
        await pool.execute(`
            INSERT INTO light_timings (traffic_light_id, green_time, red_time, yellow_time, timing_type)
            VALUES (?, ?, ?, ?, 'manual')
        `, [lightId, greenTime, redTime, yellowTime]);
        
        // 发布消息到Redis
        await publishMessage('traffic_light:control', {
            intersectionId,
            lightId,
            action,
            direction: currentLight[0].direction,
            duration: newRemainingTime,
            timestamp: new Date()
        });
        
        // 清除缓存
        await setCache(`traffic_lights:${intersectionId}`, null, 0);
        
        res.json({
            success: true,
            message: '红绿灯控制成功',
            data: {
                lightId,
                newStatus,
                remainingTime: newRemainingTime
            }
        });
    } catch (error) {
        console.error('红绿灯控制失败:', error);
        res.status(500).json({
            success: false,
            message: '红绿灯控制失败',
            error: error.message
        });
    }
});

// 获取红绿灯时序历史
router.get('/timing-history', async (req, res) => {
    try {
        const { intersectionId, startDate, endDate, lightId } = req.query;
        
        if (!intersectionId) {
            return res.status(400).json({
                success: false,
                message: '缺少路口ID参数'
            });
        }
        
        let whereConditions = ['tl.intersection_id = ?'];
        let queryParams = [intersectionId];
        
        if (startDate) {
            whereConditions.push('lt.created_at >= ?');
            queryParams.push(startDate);
        }
        
        if (endDate) {
            whereConditions.push('lt.created_at <= ?');
            queryParams.push(endDate);
        }
        
        if (lightId) {
            whereConditions.push('lt.traffic_light_id = ?');
            queryParams.push(lightId);
        }
        
        const [rows] = await pool.execute(`
            SELECT 
                lt.id,
                lt.traffic_light_id,
                tl.direction,
                lt.green_time,
                lt.red_time,
                lt.yellow_time,
                lt.timing_type,
                lt.effective_from,
                lt.created_at
            FROM light_timings lt
            JOIN traffic_lights tl ON lt.traffic_light_id = tl.id
            WHERE ${whereConditions.join(' AND ')}
            ORDER BY lt.created_at DESC
            LIMIT 100
        `, queryParams);
        
        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error('获取时序历史失败:', error);
        res.status(500).json({
            success: false,
            message: '获取时序历史失败',
            error: error.message
        });
    }
});

// 批量更新红绿灯配置
router.post('/batch-config', async (req, res) => {
    try {
        const { intersectionId, lightsConfig } = req.body;
        
        if (!intersectionId || !Array.isArray(lightsConfig)) {
            return res.status(400).json({
                success: false,
                message: '缺少必要参数或参数格式错误'
            });
        }
        
        const updatePromises = lightsConfig.map(async (config) => {
            const { lightId, defaultGreenTime, defaultRedTime, defaultYellowTime } = config;
            
            if (!lightId) {
                throw new Error('缺少红绿灯ID');
            }
            
            return pool.execute(`
                UPDATE traffic_lights 
                SET 
                    default_green_time = COALESCE(?, default_green_time),
                    default_red_time = COALESCE(?, default_red_time),
                    default_yellow_time = COALESCE(?, default_yellow_time),
                    updated_at = NOW()
                WHERE id = ? AND intersection_id = ?
            `, [defaultGreenTime, defaultRedTime, defaultYellowTime, lightId, intersectionId]);
        });
        
        await Promise.all(updatePromises);
        
        // 清除缓存
        await setCache(`traffic_lights:${intersectionId}`, null, 0);
        
        res.json({
            success: true,
            message: '红绿灯配置批量更新成功'
        });
    } catch (error) {
        console.error('批量更新红绿灯配置失败:', error);
        res.status(500).json({
            success: false,
            message: '批量更新红绿灯配置失败',
            error: error.message
        });
    }
});

// 获取红绿灯状态统计
router.get('/statistics/:intersectionId', async (req, res) => {
    try {
        const { intersectionId } = req.params;
        const { period = 'day' } = req.query;
        
        let timeCondition;
        switch (period) {
            case 'hour':
                timeCondition = "lt.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)";
                break;
            case 'day':
                timeCondition = "lt.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)";
                break;
            case 'week':
                timeCondition = "lt.created_at >= DATE_SUB(NOW(), INTERVAL 1 WEEK)";
                break;
            default:
                timeCondition = "lt.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)";
        }
        
        const [rows] = await pool.execute(`
            SELECT 
                tl.direction,
                tl.phase_number,
                COUNT(lt.id) as timing_changes,
                AVG(lt.green_time) as avg_green_time,
                AVG(lt.red_time) as avg_red_time,
                AVG(lt.yellow_time) as avg_yellow_time,
                SUM(CASE WHEN lt.timing_type = 'dynamic' THEN 1 ELSE 0 END) as dynamic_changes,
                SUM(CASE WHEN lt.timing_type = 'manual' THEN 1 ELSE 0 END) as manual_changes,
                SUM(CASE WHEN lt.timing_type = 'emergency' THEN 1 ELSE 0 END) as emergency_changes
            FROM traffic_lights tl
            LEFT JOIN light_timings lt ON tl.id = lt.traffic_light_id AND ${timeCondition}
            WHERE tl.intersection_id = ?
            GROUP BY tl.id, tl.direction, tl.phase_number
            ORDER BY tl.phase_number, tl.direction
        `, [intersectionId]);
        
        res.json({
            success: true,
            data: rows,
            period: period
        });
    } catch (error) {
        console.error('获取红绿灯统计失败:', error);
        res.status(500).json({
            success: false,
            message: '获取红绿灯统计失败',
            error: error.message
        });
    }
});

// 同步红绿灯状态（用于紧急情况）
router.post('/sync-emergency', async (req, res) => {
    try {
        const { intersectionId, emergencyDirection } = req.body;
        
        if (!intersectionId || !emergencyDirection) {
            return res.status(400).json({
                success: false,
                message: '缺少必要参数'
            });
        }
        
        // 获取冲突方向
        const conflictingDirections = getConflictingDirections(emergencyDirection);
        
        // 将冲突方向设置为红灯
        await pool.execute(`
            UPDATE traffic_lights 
            SET current_status = 0, remaining_time = 60, updated_at = NOW()
            WHERE intersection_id = ? AND direction IN (?)
        `, [intersectionId, conflictingDirections]);
        
        // 将紧急方向设置为绿灯
        await pool.execute(`
            UPDATE traffic_lights 
            SET current_status = 2, remaining_time = 60, updated_at = NOW()
            WHERE intersection_id = ? AND direction = ?
        `, [intersectionId, emergencyDirection]);
        
        // 发布紧急同步消息
        await publishMessage('traffic_light:emergency_sync', {
            intersectionId,
            emergencyDirection,
            conflictingDirections,
            timestamp: new Date()
        });
        
        // 清除缓存
        await setCache(`traffic_lights:${intersectionId}`, null, 0);
        
        res.json({
            success: true,
            message: '紧急同步完成',
            data: {
                emergencyDirection,
                conflictingDirections
            }
        });
    } catch (error) {
        console.error('同步红绿灯状态失败:', error);
        res.status(500).json({
            success: false,
            message: '同步红绿灯状态失败',
            error: error.message
        });
    }
});

// 辅助函数：获取冲突方向
function getConflictingDirections(direction) {
    const conflicts = {
        'North': ['East', 'West'],
        'South': ['East', 'West'],
        'East': ['North', 'South'],
        'West': ['North', 'South']
    };
    return conflicts[direction] || [];
}

// 获取所有红绿灯状态
router.get('/', async (req, res) => {
    try {
        const { intersection_id } = req.query;
        
        let whereClause = '';
        let queryParams = [];
        
        if (intersection_id) {
            whereClause = 'WHERE tl.intersection_id = ?';
            queryParams = [intersection_id];
        }
        
        const [rows] = await pool.execute(`
            SELECT 
                tl.id,
                tl.intersection_id,
                tl.direction,
                tl.movement_type,
                tl.phase_number,
                tl.current_status,
                tl.default_green_time,
                tl.default_red_time,
                tl.default_yellow_time,
                tl.remaining_time,
                tl.created_at,
                tl.updated_at,
                i.name as intersection_name
            FROM traffic_lights tl
            JOIN intersections i ON tl.intersection_id = i.id
            ${whereClause}
            ORDER BY tl.intersection_id, tl.phase_number, tl.direction, tl.movement_type
        `, queryParams);
        
        res.json({
            success: true,
            data: rows,
            count: rows.length
        });
    } catch (error) {
        console.error('获取红绿灯状态失败:', error);
        res.status(500).json({
            success: false,
            message: '获取红绿灯状态失败',
            error: error.message
        });
    }
});

// 更新单个红绿灯状态
router.put('/:id/state', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, duration = 30 } = req.body;
        
        if (!['red', 'yellow', 'green'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: '无效的状态参数'
            });
        }
        
        // 获取当前红绿灯信息
        const [currentLight] = await pool.execute(`
            SELECT tl.*, i.name as intersection_name
            FROM traffic_lights tl
            JOIN intersections i ON tl.intersection_id = i.id
            WHERE tl.id = ?
        `, [id]);
        
        if (currentLight.length === 0) {
            return res.status(404).json({
                success: false,
                message: '红绿灯不存在'
            });
        }
        
        const statusMap = { red: 0, yellow: 1, green: 2 };
        const newStatus = statusMap[status];
        
        // 更新红绿灯状态
        await pool.execute(`
            UPDATE traffic_lights 
            SET current_status = ?, remaining_time = ?, updated_at = NOW()
            WHERE id = ?
        `, [newStatus, duration, id]);
        
        // 记录时序变更
        const greenTime = newStatus === 2 ? duration : 0;
        const redTime = newStatus === 0 ? duration : 0;
        const yellowTime = newStatus === 1 ? duration : 0;
        
        await pool.execute(`
            INSERT INTO light_timings (traffic_light_id, green_time, red_time, yellow_time, timing_type)
            VALUES (?, ?, ?, ?, 'manual')
        `, [id, greenTime, redTime, yellowTime]);
        
        // 发布状态更新消息
        await publishMessage('traffic_light:state_changed', {
            lightId: id,
            intersectionId: currentLight[0].intersection_id,
            direction: currentLight[0].direction,
            oldStatus: currentLight[0].current_status,
            newStatus: newStatus,
            duration: duration,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            message: '红绿灯状态更新成功',
            data: {
                lightId: id,
                newStatus: status,
                duration: duration
            }
        });
    } catch (error) {
        console.error('更新红绿灯状态失败:', error);
        res.status(500).json({
            success: false,
            message: '更新红绿灯状态失败',
            error: error.message
        });
    }
});

// 切换红绿灯模式
router.put('/:id/mode', async (req, res) => {
    try {
        const { id } = req.params;
        const { mode } = req.body;
        
        if (!['auto', 'manual'].includes(mode)) {
            return res.status(400).json({
                success: false,
                message: '无效的模式参数'
            });
        }
        
        // 这里可以实现模式切换逻辑
        // 例如：切换到自动模式时，启动动态算法
        // 切换到手动模式时，停止自动调整
        
        await publishMessage('traffic_light:mode_changed', {
            lightId: id,
            mode: mode,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            message: `红绿灯已切换到${mode === 'auto' ? '自动' : '手动'}模式`
        });
    } catch (error) {
        console.error('切换红绿灯模式失败:', error);
        res.status(500).json({
            success: false,
            message: '切换红绿灯模式失败',
            error: error.message
        });
    }
});

// 紧急操作：所有方向红灯
router.post('/emergency/all-red', async (req, res) => {
    try {
        const { intersectionId } = req.body;
        
        if (!intersectionId) {
            return res.status(400).json({
                success: false,
                message: '缺少路口ID参数'
            });
        }
        
        // 将所有红绿灯设置为红灯
        await pool.execute(`
            UPDATE traffic_lights 
            SET current_status = 0, remaining_time = 60, updated_at = NOW()
            WHERE intersection_id = ?
        `, [intersectionId]);
        
        // 发布紧急消息
        await publishMessage('traffic_light:emergency', {
            type: 'all_red',
            intersectionId: intersectionId,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            message: '所有方向已设置为红灯'
        });
    } catch (error) {
        console.error('设置全红灯失败:', error);
        res.status(500).json({
            success: false,
            message: '设置全红灯失败',
            error: error.message
        });
    }
});

// 紧急操作：闪烁黄灯
router.post('/emergency/flash-yellow', async (req, res) => {
    try {
        const { intersectionId } = req.body;
        
        if (!intersectionId) {
            return res.status(400).json({
                success: false,
                message: '缺少路口ID参数'
            });
        }
        
        // 将所有红绿灯设置为黄灯闪烁模式
        await pool.execute(`
            UPDATE traffic_lights 
            SET current_status = 1, remaining_time = 3, updated_at = NOW()
            WHERE intersection_id = ?
        `, [intersectionId]);
        
        // 发布紧急消息
        await publishMessage('traffic_light:emergency', {
            type: 'flash_yellow',
            intersectionId: intersectionId,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            message: '所有方向已设置为闪烁黄灯'
        });
    } catch (error) {
        console.error('设置闪烁黄灯失败:', error);
        res.status(500).json({
            success: false,
            message: '设置闪烁黄灯失败',
            error: error.message
        });
    }
});

// 恢复正常交通
router.post('/restore-normal', async (req, res) => {
    try {
        const { intersectionId } = req.body;
        
        if (!intersectionId) {
            return res.status(400).json({
                success: false,
                message: '缺少路口ID参数'
            });
        }
        
        // 恢复默认的红绿灯循环
        // 这里可以实现复杂的恢复逻辑
        
        // 发布恢复消息
        await publishMessage('traffic_light:restore_normal', {
            intersectionId: intersectionId,
            timestamp: new Date()
        });
        
        res.json({
            success: true,
            message: '交通已恢复正常'
        });
    } catch (error) {
        console.error('恢复正常交通失败:', error);
        res.status(500).json({
            success: false,
            message: '恢复正常交通失败',
            error: error.message
        });
    }
});

// 批量更新红绿灯状态 (用于模拟器同步)
router.post('/batch-update', async (req, res) => {
    try {
        const { intersectionId, lights } = req.body;
        
        if (!intersectionId || !Array.isArray(lights)) {
            return res.status(400).json({
                success: false,
                message: '缺少必要参数或参数格式错误'
            });
        }

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            for (const light of lights) {
                // lights 数组应包含: { direction, movement_type, current_status, remaining_time }
                // 状态映射: 0:红, 1:黄, 2:绿
                await connection.execute(`
                    UPDATE traffic_lights 
                    SET current_status = ?, remaining_time = ?, updated_at = NOW()
                    WHERE intersection_id = ? AND direction = ? AND movement_type = ?
                `, [light.current_status, light.remaining_time, intersectionId, light.direction, light.movement_type]);
            }

            await connection.commit();
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
        
        // 清除缓存
        await setCache(`traffic_lights:${intersectionId}`, null, 0);
        
        res.json({
            success: true,
            message: '红绿灯状态已批量更新'
        });
    } catch (error) {
        console.error('批量更新红绿灯失败:', error);
        res.status(500).json({
            success: false,
            message: '批量更新红绿灯失败',
            error: error.message
        });
    }
});

export default router;
