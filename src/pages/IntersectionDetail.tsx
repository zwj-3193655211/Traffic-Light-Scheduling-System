import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { ArrowLeft, Settings, AlertTriangle, Play, Pause, RotateCcw } from 'lucide-react';

import { getSocket } from '@/lib/socket';
import type { Intersection, TrafficLight, VehicleFlow } from '@/types';

const IntersectionDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [intersection, setIntersection] = useState<Intersection | null>(null);
  const [trafficLights, setTrafficLights] = useState<TrafficLight[]>([]);
  const [vehicleFlows, setVehicleFlows] = useState<VehicleFlow[]>([]);
  const [flowHistory, setFlowHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAutoMode, setIsAutoMode] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [editIntersection, setEditIntersection] = useState<Partial<Intersection>>({});

  useEffect(() => {
    fetchIntersectionDetails();
    fetchTrafficLights();
    fetchVehicleFlows();
    
    // 复用全局 socket 单例
    const socket = getSocket();
    const onTrafficLightUpdate = () => {
      fetchTrafficLights();
    };
    socket.on('trafficLightUpdate', onTrafficLightUpdate);

    return () => {
      // 单例 socket 不在此关闭，否则会影响其他页面的实时推送；仅解绑本组件监听
      socket.off('trafficLightUpdate', onTrafficLightUpdate);
    };
  }, [id]);
  const fetchIntersectionDetails = async () => {
    try {
      const response = await fetch(`/api/intersections/${id}`);
      const json = await response.json();
      const inter = json.data?.intersection ?? json;
      setIntersection(inter);
      setEditIntersection(inter);
    } catch (error) {
      console.error('获取路口详情失败:', error);
    }
  };

  const fetchTrafficLights = async () => {
    try {
      const response = await fetch(`/api/traffic-lights/intersection/${id}`);
      const data = await response.json();
      setTrafficLights(data);
    } catch (error) {
      console.error('获取交通灯状态失败:', error);
    }
  };

  const fetchVehicleFlows = async () => {
    try {
      const response = await fetch(`/api/vehicle-flows/intersection/${id}`);
      const data = await response.json();
      setVehicleFlows(data);
      
      // 处理流量历史数据
      const history = processFlowHistory(data);
      setFlowHistory(history);
    } catch (error) {
      console.error('获取车流量数据失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const processFlowHistory = (flows: VehicleFlow[]) => {
    const historyMap = new Map();
    
    flows.forEach(flow => {
      const hour = new Date(flow.timestamp).getHours();
      const key = `${hour}:00`;
      
      if (!historyMap.has(key)) {
        historyMap.set(key, { time: key, north: 0, south: 0, east: 0, west: 0 });
      }
      
      const entry = historyMap.get(key);
      switch (flow.direction) {
        case 'north':
          entry.north += flow.vehicle_count;
          break;
        case 'south':
          entry.south += flow.vehicle_count;
          break;
        case 'east':
          entry.east += flow.vehicle_count;
          break;
        case 'west':
          entry.west += flow.vehicle_count;
          break;
      }
    });
    
    return Array.from(historyMap.values()).sort((a, b) => a.time.localeCompare(b.time));
  };

  const toggleAutoMode = async () => {
    try {
      const response = await fetch(`/api/intersections/${id}/mode`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: !isAutoMode ? 'auto' : 'manual' }),
      });
      
      if (response.ok) {
        setIsAutoMode(!isAutoMode);
      }
    } catch (error) {
      console.error('切换模式失败:', error);
    }
  };

  const resetIntersection = async () => {
    try {
      const response = await fetch(`/api/intersections/${id}/reset`, {
        method: 'POST',
      });
      
      if (response.ok) {
        fetchIntersectionDetails();
        fetchTrafficLights();
      }
    } catch (error) {
      console.error('重置路口失败:', error);
    }
  };

  const updateIntersection = async () => {
    try {
      const response = await fetch(`/api/intersections/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(editIntersection),
      });
      
      if (response.ok) {
        setIntersection({ ...intersection!, ...editIntersection });
        setShowSettings(false);
      }
    } catch (error) {
      console.error('更新路口信息失败:', error);
    }
  };

  const getStatusColor = (status: string | number) => {
    const s = typeof status === 'number' ? (status === 1 ? 'active' : 'inactive') : status;
    switch (s) {
      case 'active': return 'text-green-600 bg-green-100';
      case 'inactive': return 'text-red-600 bg-red-100';
      case 'maintenance': return 'text-yellow-600 bg-yellow-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  const getLightColor = (status: number | string) => {
    if (typeof status === 'number') {
      switch (status) {
        case 0: return 'bg-red-500';
        case 1: return 'bg-yellow-500';
        case 2: return 'bg-green-500';
        default: return 'bg-gray-400';
      }
    }
    switch (status) {
      case 'red': return 'bg-red-500';
      case 'yellow': return 'bg-yellow-500';
      case 'green': return 'bg-green-500';
      default: return 'bg-gray-300';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!intersection) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <AlertTriangle className="mx-auto h-12 w-12 text-red-500 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">路口未找到</h3>
          <p className="text-gray-500">请求的路口不存在或已被删除</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* 头部 */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => navigate('/intersections')}
              className="flex items-center px-3 py-2 text-gray-600 hover:text-gray-900 transition-colors"
            >
              <ArrowLeft className="h-5 w-5 mr-2" />
              返回列表
            </button>
            <h1 className="text-3xl font-bold text-gray-900">{intersection.name}</h1>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(intersection.status)}`}>
              {intersection.status === 'active' ? '运行中' : intersection.status === 'inactive' ? '已停用' : '维护中'}
            </span>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <Settings className="h-4 w-4 mr-2" />
              设置
            </button>
            <button
              onClick={toggleAutoMode}
              className={`flex items-center px-4 py-2 rounded-lg transition-colors ${
                isAutoMode 
                  ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' 
                  : 'bg-orange-100 text-orange-700 hover:bg-orange-200'
              }`}
            >
              {isAutoMode ? <Pause className="h-4 w-4 mr-2" /> : <Play className="h-4 w-4 mr-2" />}
              {isAutoMode ? '自动模式' : '手动模式'}
            </button>
            <button
              onClick={resetIntersection}
              className="flex items-center px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              重置
            </button>
          </div>
        </div>
        
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-white p-4 rounded-lg shadow">
              <h3 className="text-sm font-medium text-gray-500 mb-1">当前相位</h3>
              <p className="text-2xl font-bold text-gray-900">{intersection.current_phase}</p>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <h3 className="text-sm font-medium text-gray-500 mb-1">周期长度</h3>
              <p className="text-2xl font-bold text-gray-900">{intersection.cycle_length}秒</p>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <h3 className="text-sm font-medium text-gray-500 mb-1">坐标位置</h3>
              <p className="text-sm text-gray-900">{intersection.coordinates}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
            <div className="bg-white p-3 rounded-lg shadow flex items-center justify-between">
              <span className="text-sm text-gray-700">北向下一路口</span>
              {intersection.next_north_id ? (
                <button onClick={() => navigate(`/intersections/${intersection.next_north_id}`)} className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200">{intersection.next_north_name || '跳转'}</button>
              ) : (<span className="text-xs text-gray-400">无</span>)}
            </div>
            <div className="bg-white p-3 rounded-lg shadow flex items-center justify-between">
              <span className="text-sm text-gray-700">南向下一路口</span>
              {intersection.next_south_id ? (
                <button onClick={() => navigate(`/intersections/${intersection.next_south_id}`)} className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200">{intersection.next_south_name || '跳转'}</button>
              ) : (<span className="text-xs text-gray-400">无</span>)}
            </div>
            <div className="bg-white p-3 rounded-lg shadow flex items-center justify-between">
              <span className="text-sm text-gray-700">东向下一路口</span>
              {intersection.next_east_id ? (
                <button onClick={() => navigate(`/intersections/${intersection.next_east_id}`)} className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200">{intersection.next_east_name || '跳转'}</button>
              ) : (<span className="text-xs text-gray-400">无</span>)}
            </div>
            <div className="bg-white p-3 rounded-lg shadow flex items-center justify-between">
              <span className="text-sm text-gray-700">西向下一路口</span>
              {intersection.next_west_id ? (
                <button onClick={() => navigate(`/intersections/${intersection.next_west_id}`)} className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200">{intersection.next_west_name || '跳转'}</button>
              ) : (<span className="text-xs text-gray-400">无</span>)}
            </div>
          </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 交通灯状态 */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">交通灯状态</h2>
          <div className="grid grid-cols-2 gap-4">
            {trafficLights.map((light) => (
              <div key={light.id} className="border rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-gray-900">
                    {light.direction === 'north' ? '北向' : 
                     light.direction === 'south' ? '南向' : 
                     light.direction === 'east' ? '东向' : '西向'}
                  </h3>
                  <div className={`w-4 h-4 rounded-full ${getLightColor(light.status)}`}></div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">状态:</span>
                    <span className={`font-medium ${
                      light.status === 'green' ? 'text-green-600' :
                      light.status === 'yellow' ? 'text-yellow-600' :
                      'text-red-600'
                    }`}>
                      {light.status === 'green' ? '绿灯' :
                       light.status === 'yellow' ? '黄灯' : '红灯'}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">时长:</span>
                    <span className="text-gray-900">{light.duration}秒</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 实时车流量 */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">实时车流量</h2>
          <div className="space-y-4">
            {vehicleFlows.map((flow) => (
              <div key={flow.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                    <span className="text-sm font-medium text-blue-600">
                      {flow.direction === 'north' ? '北' : 
                       flow.direction === 'south' ? '南' : 
                       flow.direction === 'east' ? '东' : '西'}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">
                      {flow.direction === 'north' ? '北向' : 
                       flow.direction === 'south' ? '南向' : 
                       flow.direction === 'east' ? '东向' : '西向'}
                    </p>
                    <p className="text-sm text-gray-500">
                      {new Date(flow.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-gray-900">{flow.vehicle_count}</p>
                  <p className="text-sm text-gray-500">车辆</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 流量趋势图 */}
      <div className="mt-6 bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">24小时流量趋势</h2>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={flowHistory}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="north" stroke="#3B82F6" strokeWidth={2} name="北向" />
              <Line type="monotone" dataKey="south" stroke="#EF4444" strokeWidth={2} name="南向" />
              <Line type="monotone" dataKey="east" stroke="#10B981" strokeWidth={2} name="东向" />
              <Line type="monotone" dataKey="west" stroke="#F59E0B" strokeWidth={2} name="西向" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 设置模态框 */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">路口设置</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">路口名称</label>
                <input
                  type="text"
                  value={editIntersection.name || ''}
                  onChange={(e) => setEditIntersection({ ...editIntersection, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">坐标位置</label>
                <input
                  type="text"
                  value={editIntersection.coordinates || ''}
                  onChange={(e) => setEditIntersection({ ...editIntersection, coordinates: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                <select
                  value={String(editIntersection.status ?? 'active')}
                  onChange={(e) => setEditIntersection({ ...editIntersection, status: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="active">运行中</option>
                  <option value="inactive">已停用</option>
                  <option value="maintenance">维护中</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
              >
                取消
              </button>
              <button
                onClick={updateIntersection}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default IntersectionDetail;
