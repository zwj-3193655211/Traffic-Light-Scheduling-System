import express from 'express';
const router = express.Router();
import { pool } from '../config/database.js';
import { setCache, getCache, publishMessage } from '../config/redis.js';

// 报告紧急车辆
router.post('/report', async (req, res) => {
    try {
        const { 
            vehicleType, 
            intersectionId, 
            direction, 
            priorityLevel = 3, 
            estimatedArrival,
            vehicleId,
            latitude,
            longitude
        } = req.body;
        
        if (!vehicleType || !intersectionId || !direction) {
            return res.status(400).json({
                success: false,
                message: '缺少必要参数'
            });
        }
        
        // 验证车辆类型
        const validVehicleTypes = ['ambulance', 'fire_truck', 'police'];
        if (!validVehicleTypes.includes(vehicleType)) {
            return res.status(400).json({
                success: false,
                message: '无效的车辆类型'
            });
        }
        
        // 验证方向
        const validDirections = ['North', 'South', 'East', 'West'];
        if (!validDirections.includes(direction)) {
            return res.status(400).json({
                success: false,
                message: '无效的方向参数'
            });
        }
        
        // 验证优先级
        if (priorityLevel < 1 || priorityLevel > 5) {
            return res.status(400).json({
                success: false,
                message: '优先级必须在1-5之间'
            });
        }
        
        // 如果没有提供预计到达时间，默认为5分钟后
        let arrivalTime = estimatedArrival;
        if (!arrivalTime) {
            arrivalTime = new Date(Date.now() + 5 * 60 * 1000); // 5分钟后
        }
        
        const [result] = await pool.execute(`
            INSERT INTO emergency_vehicles (
                intersection_id, vehicle_type, vehicle_id, 
                latitude, longitude, priority_level, 
                estimated_arrival, direction
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            intersectionId,
            vehicleType,
            vehicleId || `${vehicleType}_${Date.now()}`,
            latitude || 0,
            longitude || 0,
            priorityLevel,
            arrivalTime,
            direction
        ]);
        
        const emergencyVehicle = {
            id: result.insertId,
            intersectionId,
            vehicleType,
            vehicleId: vehicleId || `${vehicleType}_${Date.now()}`,
            latitude: latitude || 0,
            longitude: longitude || 0,
            priorityLevel,
            estimatedArrival: arrivalTime,
            direction,
            status: 0,
            createdAt: new Date()
        };
        
        // 发布紧急车辆消息
        await publishMessage('emergency:vehicle', {
            type: 'new_emergency',
            data: emergencyVehicle,
            timestamp: new Date()
        });
        
        // 触发紧急处理流程
        await triggerEmergencyHandling(emergencyVehicle);
        
        res.json({
            success: true,
            data: emergencyVehicle,
            message: '紧急车辆报告成功'
        });
    } catch (error) {
        console.error('报告紧急车辆失败:', error);
        res.status(500).json({
            success: false,
            message: '报告紧急车辆失败',
            error: error.message
        });
    }
});

// 获取紧急事件列表
router.get('/events', async (req, res) => {
    try {
        const { status, intersectionId, limit = 50 } = req.query;
        
        let whereConditions = [];
        let queryParams = [];
        
        if (status !== undefined) {
            whereConditions.push('status = ?');
            queryParams.push(status);
        }
        
        if (intersectionId) {
            whereConditions.push('intersection_id = ?');
            queryParams.push(intersectionId);
        }
        
        const whereClause = whereConditions.length > 0 
            ? `WHERE ${whereConditions.join(' AND ')}`
            : '';
        
        const lim = Number.isFinite(parseInt(limit)) ? Math.max(1, parseInt(limit)) : 50;
        const [rows] = await pool.execute(`
            SELECT 
                id,
                intersection_id,
                vehicle_type,
                vehicle_id,
                latitude,
                longitude,
                priority_level,
                direction,
                estimated_arrival,
                status,
                created_at,
                updated_at
            FROM emergency_vehicles
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ${lim}
        `, queryParams);
        
        res.json({
            success: true,
            data: rows,
            count: rows.length
        });
    } catch (error) {
        console.error('获取紧急事件列表失败:', error);
        res.status(500).json({
            success: false,
            message: '获取紧急事件列表失败',
            error: error.message
        });
    }
});

// 更新紧急车辆状态
router.put('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        if (status === undefined || (status !== 0 && status !== 1)) {
            return res.status(400).json({
                success: false,
                message: '状态参数无效（必须为0或1）'
            });
        }
        
        const [result] = await pool.execute(`
            UPDATE emergency_vehicles 
            SET status = ?, updated_at = NOW()
            WHERE id = ?
        `, [status, id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: '紧急车辆不存在'
            });
        }
        
        // 获取更新后的紧急车辆信息
        const [updatedVehicle] = await pool.execute(`
            SELECT * FROM emergency_vehicles WHERE id = ?
        `, [id]);
        
        if (updatedVehicle.length > 0) {
            // 发布状态更新消息
            await publishMessage('emergency:vehicle', {
                type: 'status_update',
                data: updatedVehicle[0],
                timestamp: new Date()
            });
            
            // 如果状态变为已通过，恢复正常交通
            if (status === 1) {
                await restoreNormalTraffic(updatedVehicle[0]);
            }
        }
        
        res.json({
            success: true,
            message: '紧急车辆状态更新成功'
        });
    } catch (error) {
        console.error('更新紧急车辆状态失败:', error);
        res.status(500).json({
            success: false,
            message: '更新紧急车辆状态失败',
            error: error.message
        });
    }
});

// 获取紧急车辆统计
router.get('/statistics', async (req, res) => {
    try {
        const { intersectionId, days = 7 } = req.query;
        
        let whereConditions = ['created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)'];
        let queryParams = [days];
        
        if (intersectionId) {
            whereConditions.push('intersection_id = ?');
            queryParams.push(intersectionId);
        }
        
        const whereClause = whereConditions.join(' AND ');
        
        // 总体统计
        const [overallStats] = await pool.execute(`
            SELECT 
                COUNT(*) as total_events,
                COUNT(CASE WHEN status = 0 THEN 1 END) as pending_events,
                COUNT(CASE WHEN status = 1 THEN 1 END) as processed_events,
                AVG(priority_level) as avg_priority,
                vehicle_type,
                COUNT(*) as count
            FROM emergency_vehicles
            WHERE ${whereClause}
            GROUP BY vehicle_type
            ORDER BY count DESC
        `, queryParams);
        
        // 每日统计
        const [dailyStats] = await pool.execute(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as daily_events,
                COUNT(CASE WHEN status = 0 THEN 1 END) as pending_daily,
                COUNT(CASE WHEN status = 1 THEN 1 END) as processed_daily,
                AVG(priority_level) as avg_priority_daily
            FROM emergency_vehicles
            WHERE ${whereClause}
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `, queryParams);
        
        // 路口统计
        const [intersectionStats] = await pool.execute(`
            SELECT 
                intersection_id,
                COUNT(*) as event_count,
                COUNT(CASE WHEN status = 0 THEN 1 END) as pending_count,
                COUNT(CASE WHEN status = 1 THEN 1 END) as processed_count,
                AVG(priority_level) as avg_priority
            FROM emergency_vehicles
            WHERE ${whereClause}
            GROUP BY intersection_id
            ORDER BY event_count DESC
        `, queryParams);
        
        res.json({
            success: true,
            data: {
                period: `${days} days`,
                overall: overallStats,
                daily: dailyStats,
                byIntersection: intersectionStats
            }
        });
    } catch (error) {
        console.error('获取紧急车辆统计失败:', error);
        res.status(500).json({
            success: false,
            message: '获取紧急车辆统计失败',
            error: error.message
        });
    }
});

// 取消紧急车辆
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 获取紧急车辆信息（用于恢复交通）
        const [vehicle] = await pool.execute(`
            SELECT * FROM emergency_vehicles WHERE id = ?
        `, [id]);
        
        if (vehicle.length === 0) {
            return res.status(404).json({
                success: false,
                message: '紧急车辆不存在'
            });
        }
        
        // 删除紧急车辆记录
        const [result] = await pool.execute(`
            DELETE FROM emergency_vehicles WHERE id = ?
        `, [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: '紧急车辆不存在'
            });
        }
        
        // 发布取消消息
        await publishMessage('emergency:vehicle', {
            type: 'cancelled',
            data: vehicle[0],
            timestamp: new Date()
        });
        
        // 恢复正常交通
        await restoreNormalTraffic(vehicle[0]);
        
        res.json({
            success: true,
            message: '紧急车辆已取消'
        });
    } catch (error) {
        console.error('取消紧急车辆失败:', error);
        res.status(500).json({
            success: false,
            message: '取消紧急车辆失败',
            error: error.message
        });
    }
});

// 辅助函数：触发紧急处理
async function triggerEmergencyHandling(emergencyVehicle) {
    try {
        // 获取当前路口的红绿灯状态
        const [currentLights] = await pool.execute(`
            SELECT id, direction, current_status, remaining_time
            FROM traffic_lights
            WHERE intersection_id = ?
        `, [emergencyVehicle.intersectionId]);
        
        // 检查是否可以安全切换
        const canSwitch = await canSafelySwitchToEmergency(emergencyVehicle, currentLights);
        
        if (canSwitch) {
            // 执行紧急切换
            await executeEmergencySwitch(emergencyVehicle);
            
            // 发布紧急切换消息
            await publishMessage('emergency:vehicle', {
                type: 'emergency_switch',
                data: {
                    emergencyVehicle: emergencyVehicle,
                    action: 'switch_to_emergency',
                    timestamp: new Date()
                }
            });
        } else {
            // 安排延迟切换
            await scheduleDelayedEmergencySwitch(emergencyVehicle);
        }
        
    } catch (error) {
        console.error('触发紧急处理失败:', error);
    }
}

// 辅助函数：检查是否可以安全切换
async function canSafelySwitchToEmergency(emergencyVehicle, currentLights) {
    try {
        const conflictingDirections = getConflictingDirections(emergencyVehicle.direction);
        
        // 检查冲突方向是否有绿灯
        for (const light of currentLights) {
            if (conflictingDirections.includes(light.direction) && light.current_status === 2) {
                // 检查该方向是否有车辆
                const [recentFlow] = await pool.execute(`
                    SELECT vehicle_count 
                    FROM vehicle_flows 
                    WHERE intersection_id = ? AND direction = ? 
                    AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 SECOND)
                    ORDER BY timestamp DESC 
                    LIMIT 1
                `, [emergencyVehicle.intersectionId, light.direction]);
                
                if (recentFlow.length > 0 && recentFlow[0].vehicle_count > 0) {
                    return false; // 有车辆，不能立即切换
                }
            }
        }
        
        return true; // 可以安全切换
    } catch (error) {
        console.error('安全检查失败:', error);
        return false;
    }
}

// 辅助函数：执行紧急切换
async function executeEmergencySwitch(emergencyVehicle) {
    try {
        const conflictingDirections = getConflictingDirections(emergencyVehicle.direction);
        
        // 将冲突方向设置为红灯
        await pool.execute(`
            UPDATE traffic_lights 
            SET current_status = 0, remaining_time = 3, updated_at = NOW()
            WHERE intersection_id = ? AND direction IN (?)
        `, [emergencyVehicle.intersectionId, conflictingDirections]);
        
        // 等待黄灯时间（3秒）
        setTimeout(async () => {
            // 将紧急方向设置为绿灯
            await pool.execute(`
                UPDATE traffic_lights 
                SET current_status = 2, remaining_time = 60, updated_at = NOW()
                WHERE intersection_id = ? AND direction = ?
            `, [emergencyVehicle.intersectionId, emergencyVehicle.direction]);
            
            // 发布切换完成消息
            await publishMessage('emergency:vehicle', {
                type: 'switch_completed',
                data: {
                    emergencyVehicle: emergencyVehicle,
                    timestamp: new Date()
                }
            });
        }, 3000);
        
    } catch (error) {
        console.error('执行紧急切换失败:', error);
    }
}

// 辅助函数：安排延迟紧急切换
async function scheduleDelayedEmergencySwitch(emergencyVehicle) {
    try {
        // 这里可以实现更复杂的延迟逻辑
        // 例如：等待当前绿灯周期结束，或等待车辆通过
        
        setTimeout(async () => {
            await executeEmergencySwitch(emergencyVehicle);
        }, 10000); // 10秒后尝试切换
        
    } catch (error) {
        console.error('安排延迟紧急切换失败:', error);
    }
}

// 辅助函数：恢复正常交通
async function restoreNormalTraffic(emergencyVehicle) {
    try {
        // 恢复正常红绿灯循环
        // 这里可以实现复杂的恢复逻辑
        
        await publishMessage('emergency:vehicle', {
            type: 'traffic_restored',
            data: {
                intersectionId: emergencyVehicle.intersection_id,
                timestamp: new Date()
            }
        });
        
    } catch (error) {
        console.error('恢复正常交通失败:', error);
    }
}

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

// 获取紧急车辆列表
router.get('/', async (req, res) => {
    try {
        const { status, intersectionId, limit = 50 } = req.query;
        
        let whereConditions = [];
        let queryParams = [];
        
        if (status !== undefined) {
            whereConditions.push('status = ?');
            queryParams.push(status);
        }
        
        if (intersectionId) {
            whereConditions.push('intersection_id = ?');
            queryParams.push(intersectionId);
        }
        
        const whereClause = whereConditions.length > 0 
            ? `WHERE ${whereConditions.join(' AND ')}`
            : '';
        
        const lim2 = Number.isFinite(parseInt(limit)) ? Math.max(1, parseInt(limit)) : 50;
        const [rows] = await pool.execute(`
            SELECT 
                id,
                intersection_id,
                vehicle_type,
                vehicle_id,
                latitude,
                longitude,
                priority_level,
                direction,
                estimated_arrival,
                status,
                created_at,
                updated_at
            FROM emergency_vehicles
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ${lim2}
        `, queryParams);
        
        res.json({
            success: true,
            data: rows,
            count: rows.length
        });
    } catch (error) {
        console.error('获取紧急车辆列表失败:', error);
        res.status(500).json({
            success: false,
            message: '获取紧急车辆列表失败',
            error: error.message
        });
    }
});

// 取消紧急车辆
router.post('/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 获取紧急车辆信息
        const [vehicle] = await pool.execute(`
            SELECT * FROM emergency_vehicles WHERE id = ?
        `, [id]);
        
        if (vehicle.length === 0) {
            return res.status(404).json({
                success: false,
                message: '紧急车辆不存在'
            });
        }
        
        // 更新状态为已取消
        await pool.execute(`
            UPDATE emergency_vehicles 
            SET status = 2, updated_at = NOW()
            WHERE id = ?
        `, [id]);
        
        // 发布取消消息
        await publishMessage('emergency:vehicle', {
            type: 'cancelled',
            data: vehicle[0],
            timestamp: new Date()
        });
        
        // 恢复正常交通
        await restoreNormalTraffic(vehicle[0]);
        
        res.json({
            success: true,
            message: '紧急车辆已取消'
        });
    } catch (error) {
        console.error('取消紧急车辆失败:', error);
        res.status(500).json({
            success: false,
            message: '取消紧急车辆失败',
            error: error.message
        });
    }
});

// 完成紧急车辆通行
router.post('/:id/complete', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 获取紧急车辆信息
        const [vehicle] = await pool.execute(`
            SELECT * FROM emergency_vehicles WHERE id = ?
        `, [id]);
        
        if (vehicle.length === 0) {
            return res.status(404).json({
                success: false,
                message: '紧急车辆不存在'
            });
        }
        
        // 更新状态为已完成
        await pool.execute(`
            UPDATE emergency_vehicles 
            SET status = 1, updated_at = NOW()
            WHERE id = ?
        `, [id]);
        
        // 发布完成消息
        await publishMessage('emergency:vehicle', {
            type: 'completed',
            data: vehicle[0],
            timestamp: new Date()
        });
        
        // 恢复正常交通
        await restoreNormalTraffic(vehicle[0]);
        
        res.json({
            success: true,
            message: '紧急车辆通行已完成'
        });
    } catch (error) {
        console.error('完成紧急车辆通行失败:', error);
        res.status(500).json({
            success: false,
            message: '完成紧急车辆通行失败',
            error: error.message
        });
    }
});

export default router;
