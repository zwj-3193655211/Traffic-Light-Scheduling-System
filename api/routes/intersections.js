import express from 'express';
const router = express.Router();
import * as db from '../config/database.js';
import * as redisCfg from '../config/redis.js';

// 获取所有路口
router.get('/', async (req, res) => {
    try {
        const includeMaintenance = String(req.query.include_maintenance ?? '') === '1';
        const cacheKey = includeMaintenance ? 'intersections:all:include_maintenance' : 'intersections:all:active_only';
        
        // 尝试从缓存获取
        const cachedData = await redisCfg.getCache(cacheKey);
        if (cachedData) {
            return res.json({
                success: true,
                data: cachedData,
                fromCache: true
            });
        }
        
        // 从数据库获取
        const [rows] = await db.pool.execute(`
            SELECT id, name, latitude, longitude, status,
                   next_north_id, next_south_id, next_east_id, next_west_id,
                   created_at, updated_at
            FROM intersections
            ${includeMaintenance ? '' : 'WHERE status = 1'}
            ORDER BY created_at DESC
        `);
        
        // 缓存结果（5分钟）
        await redisCfg.setCache(cacheKey, rows, 300);
        
        res.json({
            success: true,
            data: rows,
            fromCache: false
        });
    } catch (error) {
        console.error('获取路口列表失败:', error);
        res.status(500).json({
            success: false,
            message: '获取路口列表失败',
            error: error.message
        });
    }
});

// 获取路口详情
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cacheKey = `intersection:${id}`;
        
        // 尝试从缓存获取
        const cachedData = await redisCfg.getCache(cacheKey);
        if (cachedData) {
            return res.json({
                success: true,
                data: cachedData,
                fromCache: true
            });
        }
        
        // 获取路口基本信息
        const [intersectionRows] = await db.pool.execute(`
            SELECT id, name, latitude, longitude, status, auto_mode, current_phase, cycle_length,
                   next_north_id, next_south_id, next_east_id, next_west_id,
                   created_at, updated_at
            FROM intersections
            WHERE id = ?
        `, [id]);
        
        if (intersectionRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: '路口不存在'
            });
        }
        
        // 获取红绿灯信息
        const [trafficLightRows] = await db.pool.execute(`
            SELECT id, direction, movement_type, phase_number, current_status, 
                   default_green_time, default_red_time, default_yellow_time,
                   remaining_time, created_at, updated_at
            FROM traffic_lights
            WHERE intersection_id = ?
            ORDER BY phase_number, direction, movement_type
        `, [id]);
        
        // 获取当前流量信息（最近5分钟）
        const [flowRows] = await db.pool.execute(`
            SELECT direction, vehicle_count, average_speed, timestamp
            FROM vehicle_flows
            WHERE intersection_id = ? AND timestamp >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
            ORDER BY timestamp DESC
        `, [id]);
        
        const base = intersectionRows[0];
        let nextNames = {};
        const nextIds = [base.next_north_id, base.next_south_id, base.next_east_id, base.next_west_id].filter(Boolean);
        if (nextIds.length > 0) {
            const [nextRows] = await db.pool.execute(`
                SELECT id, name FROM intersections WHERE id IN (${nextIds.map(() => '?').join(',')})
            `, nextIds);
            const map = Object.fromEntries(nextRows.map(r => [r.id, r.name]));
            nextNames = {
                next_north_name: base.next_north_id ? map[base.next_north_id] || null : null,
                next_south_name: base.next_south_id ? map[base.next_south_id] || null : null,
                next_east_name: base.next_east_id ? map[base.next_east_id] || null : null,
                next_west_name: base.next_west_id ? map[base.next_west_id] || null : null,
            };
        }
        const result = {
            intersection: { ...base, ...nextNames },
            trafficLights: trafficLightRows,
            currentFlow: flowRows
        };
        
        // 缓存结果（2分钟）
        await redisCfg.setCache(cacheKey, result, 120);
        
        res.json({
            success: true,
            data: result,
            fromCache: false
        });
    } catch (error) {
        console.error('获取路口详情失败:', error);
        res.status(500).json({
            success: false,
            message: '获取路口详情失败',
            error: error.message
        });
    }
});

// 创建路口
router.post('/', async (req, res) => {
    try {
        const { name, latitude, longitude, status = 1,
                next_north_id = null, next_south_id = null, next_east_id = null, next_west_id = null } = req.body;
        
        if (!name || !latitude || !longitude) {
            return res.status(400).json({
                success: false,
                message: '缺少必要参数'
            });
        }
        
        const [result] = await db.pool.execute(`
            INSERT INTO intersections (name, latitude, longitude, status, next_north_id, next_south_id, next_east_id, next_west_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [name, latitude, longitude, status, next_north_id, next_south_id, next_east_id, next_west_id]);
        
        const intersectionId = result.insertId;
        
        // 创建默认的红绿灯配置（十字路口：北南东西）
        const defaultLights = [
            { direction: 'North', phase_number: 1, default_green_time: 30 },
            { direction: 'South', phase_number: 1, default_green_time: 30 },
            { direction: 'East', phase_number: 2, default_green_time: 30 },
            { direction: 'West', phase_number: 2, default_green_time: 30 }
        ];
        
        for (const light of defaultLights) {
            const initialStatus = light.phase_number === 1 ? 2 : 0;
            const initialRemaining = light.phase_number === 1 ? light.default_green_time : 30;
            await db.pool.execute(`
                INSERT INTO traffic_lights (
                    intersection_id, direction, phase_number, 
                    default_green_time, default_red_time, default_yellow_time,
                    current_status, remaining_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                intersectionId, 
                light.direction, 
                light.phase_number,
                light.default_green_time,
                30, // 默认红灯时间
                3,   // 默认黄灯时间
                initialStatus,
                initialRemaining
            ]);
        }
        
        // 同步设置相互“下一路口”
        const pairs = [
            { field: 'next_north_id', opposite: 'next_south_id', value: next_north_id },
            { field: 'next_south_id', opposite: 'next_north_id', value: next_south_id },
            { field: 'next_east_id',  opposite: 'next_west_id',  value: next_east_id },
            { field: 'next_west_id',  opposite: 'next_east_id',  value: next_west_id },
        ]
        for (const p of pairs) {
            if (p.value && Number(p.value) !== intersectionId) {
                try {
                    await db.pool.execute(`UPDATE intersections SET ${p.opposite} = ? WHERE id = ?`, [intersectionId, p.value])
                } catch (e) { console.warn('设置相互下一路口失败', p, e?.message) }
            }
        }

        // 清除相关缓存
        try { await redisCfg.deleteCache('intersections:all') } catch {}
        
        res.json({
            success: true,
            data: {
                id: intersectionId,
                name,
                latitude,
                longitude,
                status,
                next_north_id,
                next_south_id,
                next_east_id,
                next_west_id
            },
            message: '路口创建成功'
        });
    } catch (error) {
        console.error('创建路口失败:', error);
        res.status(500).json({
            success: false,
            message: '创建路口失败',
            error: error.message
        });
    }
});

// 更新路口信息
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, latitude, longitude, status, auto_mode, current_phase, cycle_length,
                next_north_id, next_south_id, next_east_id, next_west_id } = req.body;
        
        if (!name && !latitude && !longitude && status === undefined && auto_mode === undefined && current_phase === undefined && cycle_length === undefined
            && next_north_id === undefined && next_south_id === undefined && next_east_id === undefined && next_west_id === undefined) {
            return res.status(400).json({
                success: false,
                message: '缺少更新参数'
            });
        }
        
        // 构建动态更新语句
        const updateFields = [];
        const updateValues = [];
        
        if (name !== undefined) {
            updateFields.push('name = ?');
            updateValues.push(name);
        }
        if (latitude !== undefined) {
            updateFields.push('latitude = ?');
            updateValues.push(latitude);
        }
        if (longitude !== undefined) {
            updateFields.push('longitude = ?');
            updateValues.push(longitude);
        }
        if (status !== undefined) {
            updateFields.push('status = ?');
            updateValues.push(status);
        }
        if (auto_mode !== undefined) {
            updateFields.push('auto_mode = ?');
            updateValues.push(auto_mode);
        }
        if (current_phase !== undefined) {
            updateFields.push('current_phase = ?');
            updateValues.push(current_phase);
        }
        if (cycle_length !== undefined) {
            updateFields.push('cycle_length = ?');
            updateValues.push(cycle_length);
        }
        if (next_north_id !== undefined) {
            updateFields.push('next_north_id = ?');
            updateValues.push(next_north_id);
        }
        if (next_south_id !== undefined) {
            updateFields.push('next_south_id = ?');
            updateValues.push(next_south_id);
        }
        if (next_east_id !== undefined) {
            updateFields.push('next_east_id = ?');
            updateValues.push(next_east_id);
        }
        if (next_west_id !== undefined) {
            updateFields.push('next_west_id = ?');
            updateValues.push(next_west_id);
        }
        
        updateValues.push(id); // WHERE条件
        
        const [result] = await db.pool.execute(`
            UPDATE intersections 
            SET ${updateFields.join(', ')}, updated_at = NOW()
            WHERE id = ?
        `, updateValues);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: '路口不存在'
            });
        }
        
        // 同步设置/清理相互“下一路口”
        const reciprocalOps = [
            { provided: next_north_id, setOpp: 'next_south_id' },
            { provided: next_south_id, setOpp: 'next_north_id' },
            { provided: next_east_id,  setOpp: 'next_west_id'  },
            { provided: next_west_id,  setOpp: 'next_east_id'  },
        ]
        for (const op of reciprocalOps) {
            if (op.provided !== undefined) {
                if (op.provided) {
                    if (Number(op.provided) !== Number(id)) {
                        try { await db.pool.execute(`UPDATE intersections SET ${op.setOpp} = ? WHERE id = ?`, [id, op.provided]) } catch (e) { console.warn('设置相互下一路口失败', op, e?.message) }
                    }
                } else {
                    // 清理此前指向当前路口的相反方向引用
                    const oppositeField = op.setOpp;
                    try { await db.pool.execute(`UPDATE intersections SET ${oppositeField} = NULL WHERE ${oppositeField} = ?`, [id]) } catch (e) { console.warn('清理相互下一路口失败', op, e?.message) }
                }
            }
        }

        // 清除相关缓存
        try { await redisCfg.deleteCache('intersections:all') } catch {}
        try { await redisCfg.deleteCache(`intersection:${id}`) } catch {}
        
        res.json({
            success: true,
            message: '路口信息更新成功'
        });
    } catch (error) {
        console.error('更新路口信息失败:', error);
        res.status(500).json({
            success: false,
            message: '更新路口信息失败',
            error: error.message
        });
    }
});

// 删除路口
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [result] = await db.pool.execute(`
            DELETE FROM intersections WHERE id = ?
        `, [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: '路口不存在'
            });
        }
        
        // 清除相关缓存
        try { await redisCfg.deleteCache('intersections:all') } catch {}
        try { await redisCfg.deleteCache(`intersection:${id}`) } catch {}
        
        res.json({
            success: true,
            message: '路口删除成功'
        });
    } catch (error) {
        console.error('删除路口失败:', error);
        res.status(500).json({
            success: false,
            message: '删除路口失败',
            error: error.message
        });
    }
});

// 获取路口统计信息
router.get('/:id/statistics', async (req, res) => {
    try {
        const { id } = req.params;
        const { period = 'day' } = req.query;
        
        let timeCondition;
        switch (period) {
            case 'hour':
                timeCondition = 'timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR)';
                break;
            case 'day':
                timeCondition = 'timestamp >= DATE_SUB(NOW(), INTERVAL 1 DAY)';
                break;
            case 'week':
                timeCondition = 'timestamp >= DATE_SUB(NOW(), INTERVAL 1 WEEK)';
                break;
            default:
                timeCondition = 'timestamp >= DATE_SUB(NOW(), INTERVAL 1 DAY)';
        }
        
        // 获取流量统计
        const [flowStats] = await pool.execute(`
            SELECT 
                direction,
                COUNT(*) as record_count,
                SUM(vehicle_count) as total_vehicles,
                AVG(vehicle_count) as avg_vehicles,
                AVG(average_speed) as avg_speed,
                MAX(vehicle_count) as max_flow,
                MIN(vehicle_count) as min_flow
            FROM vehicle_flows
            WHERE intersection_id = ? AND ${timeCondition}
            GROUP BY direction
            ORDER BY total_vehicles DESC
        `, [id]);
        
        // 获取红绿灯切换统计
        const [timingStats] = await pool.execute(`
            SELECT 
                tl.direction,
                COUNT(*) as timing_changes,
                AVG(lt.green_time) as avg_green_time,
                AVG(lt.red_time) as avg_red_time,
                AVG(lt.yellow_time) as avg_yellow_time
            FROM light_timings lt
            JOIN traffic_lights tl ON lt.traffic_light_id = tl.id
            WHERE tl.intersection_id = ? AND lt.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
            GROUP BY tl.direction
        `, [id]);
        
        // 获取紧急事件统计
        const [emergencyStats] = await pool.execute(`
            SELECT 
                vehicle_type,
                COUNT(*) as event_count,
                AVG(priority_level) as avg_priority,
                status
            FROM emergency_vehicles
            WHERE intersection_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
            GROUP BY vehicle_type, status
        `, [id]);
        
        res.json({
            success: true,
            data: {
                flowStatistics: flowStats,
                timingStatistics: timingStats,
                emergencyStatistics: emergencyStats,
                period: period
            }
        });
    } catch (error) {
        console.error('获取路口统计信息失败:', error);
        res.status(500).json({
            success: false,
            message: '获取路口统计信息失败',
            error: error.message
        });
    }
});

// 切换路口模式
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
        
        const [result] = await pool.execute(`
            UPDATE intersections 
            SET auto_mode = ?, updated_at = NOW()
            WHERE id = ?
        `, [mode === 'auto' ? 1 : 0, id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: '路口不存在'
            });
        }
        
        // 清除相关缓存
        await setCache(`intersection:${id}`, null, 0);
        
        res.json({
            success: true,
            message: `路口已切换到${mode === 'auto' ? '自动' : '手动'}模式`
        });
    } catch (error) {
        console.error('切换路口模式失败:', error);
        res.status(500).json({
            success: false,
            message: '切换路口模式失败',
            error: error.message
        });
    }
});

// 重置路口状态
router.post('/:id/reset', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 重置红绿灯状态
        await pool.execute(`
            UPDATE traffic_lights 
            SET current_status = 0, remaining_time = default_red_time, 
                updated_at = NOW()
            WHERE intersection_id = ?
        `, [id]);
        
        // 重置路口状态
        await pool.execute(`
            UPDATE intersections 
            SET current_phase = 1, cycle_length = 120, updated_at = NOW()
            WHERE id = ?
        `, [id]);
        
        // 清除相关缓存
        await setCache(`intersection:${id}`, null, 0);
        
        res.json({
            success: true,
            message: '路口状态已重置'
        });
    } catch (error) {
        console.error('重置路口状态失败:', error);
        res.status(500).json({
            success: false,
            message: '重置路口状态失败',
            error: error.message
        });
    }
});

// 更新路口状态
router.put('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        const statusMap = { 'active': 1, 'inactive': 0, 'maintenance': 0 };
        if (statusMap[status] === undefined) {
            return res.status(400).json({
                success: false,
                message: '无效的状态参数'
            });
        }
        const numericStatus = statusMap[status];
        
        const [result] = await pool.execute(`
            UPDATE intersections 
            SET status = ?, updated_at = NOW()
            WHERE id = ?
        `, [numericStatus, id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: '路口不存在'
            });
        }
        
        // 清除相关缓存
        await setCache('intersections:all', null, 0);
        await setCache(`intersection:${id}`, null, 0);
        
        res.json({
            success: true,
            message: '路口状态已更新'
        });
    } catch (error) {
        console.error('更新路口状态失败:', error);
        res.status(500).json({
            success: false,
            message: '更新路口状态失败',
            error: error.message
        });
    }
});

export default router;
