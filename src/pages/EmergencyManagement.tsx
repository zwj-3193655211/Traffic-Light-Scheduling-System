import React, { useState, useEffect } from 'react';

import type { EmergencyVehicle, TrafficLight } from '@/types';

const EmergencyManagement: React.FC = () => {
  const [emergencyVehicles, setEmergencyVehicles] = useState<EmergencyVehicle[]>([]);
  const [trafficLights, setTrafficLights] = useState<TrafficLight[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    vehicle_type: 'ambulance' as const,
    license_plate: '',
    priority_level: 5 as const,
    current_location: '',
    destination: ''
  });

  useEffect(() => {
    fetchEmergencyVehicles();
    fetchTrafficLights();
  }, []);

  const fetchEmergencyVehicles = async () => {
    try {
      const response = await fetch('/api/emergency-vehicles');
      const json = await response.json();
      setEmergencyVehicles(json.data || []);
    } catch (error) {
      console.error('获取紧急车辆信息失败:', error);
    }
  };

  const fetchTrafficLights = async () => {
    try {
      const response = await fetch('/api/traffic-lights');
      const json = await response.json();
      setTrafficLights(json.data || []);
    } catch (error) {
      console.error('获取红绿灯信息失败:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      const response = await fetch('/api/emergency-vehicles/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vehicleType: formData.vehicle_type,
          intersectionId: 1,
          direction: 'North',
          priorityLevel: formData.priority_level,
          estimatedArrival: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          vehicleId: formData.license_plate,
          latitude: 0,
          longitude: 0,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        setMessage('紧急车辆请求已提交，正在优先处理...');
        setShowForm(false);
        setFormData({
          vehicle_type: 'ambulance',
          license_plate: '',
          priority_level: 5,
          current_location: '',
          destination: ''
        });
        fetchEmergencyVehicles();
        setTimeout(() => setMessage(''), 5000);
      } else {
        const error = await response.json();
        setMessage(`提交失败: ${error.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } catch (error) {
      setMessage('网络错误，请稍后重试');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const cancelEmergency = async (vehicleId: number) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/emergency-vehicles/${vehicleId}/cancel`, {
        method: 'POST',
      });

      if (response.ok) {
        setMessage('紧急车辆请求已取消');
        fetchEmergencyVehicles();
        setTimeout(() => setMessage(''), 3000);
      } else {
        const error = await response.json();
        setMessage(`取消失败: ${error.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } catch (error) {
      setMessage('网络错误，请稍后重试');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const completeEmergency = async (vehicleId: number) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/emergency-vehicles/${vehicleId}/complete`, {
        method: 'POST',
      });

      if (response.ok) {
        setMessage('紧急车辆任务已完成');
        fetchEmergencyVehicles();
        setTimeout(() => setMessage(''), 3000);
      } else {
        const error = await response.json();
        setMessage(`完成失败: ${error.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } catch (error) {
      setMessage('网络错误，请稍后重试');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const getVehicleTypeText = (type: string) => {
    switch (type) {
      case 'ambulance': return '救护车';
      case 'fire_truck': return '消防车';
      case 'police': return '警车';
      case 'other': return '其他';
      default: return type;
    }
  };

  const getStatusText = (status: number) => {
    switch (status) {
      case 0: return '待处理';
      case 1: return '已通过';
      case 2: return '已取消';
      default: return String(status);
    }
  };

  const getStatusColor = (status: number) => {
    switch (status) {
      case 0: return 'bg-yellow-100 text-yellow-800';
      case 1: return 'bg-green-100 text-green-800';
      case 2: return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getPriorityColor = (priority: number) => {
    if (priority >= 4) return 'bg-red-100 text-red-800';
    if (priority >= 3) return 'bg-orange-100 text-orange-800';
    if (priority >= 2) return 'bg-yellow-100 text-yellow-800';
    return 'bg-green-100 text-green-800';
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-800 mb-2">紧急车辆管理</h1>
          <p className="text-gray-600">管理和调度紧急车辆优先通行</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 flex items-center"
        >
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          新增紧急车辆
        </button>
      </div>

      {/* 消息提示 */}
      {message && (
        <div className={`mb-4 p-4 rounded-lg border ${
          message.includes('成功') || message.includes('已') 
            ? 'bg-green-100 text-green-800 border-green-200' 
            : 'bg-red-100 text-red-800 border-red-200'
        }`}>
          {message}
        </div>
      )}

      {/* 紧急车辆表单模态框 */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-gray-800">新增紧急车辆</h2>
              <button
                onClick={() => setShowForm(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">车辆类型</label>
                <select
                  value={formData.vehicle_type}
                  onChange={(e) => setFormData({...formData, vehicle_type: e.target.value as any})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                >
                  <option value="ambulance">救护车</option>
                  <option value="fire_truck">消防车</option>
                  <option value="police">警车</option>
                  <option value="other">其他</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">车牌号码</label>
                <input
                  type="text"
                  value={formData.license_plate}
                  onChange={(e) => setFormData({...formData, license_plate: e.target.value})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="请输入车牌号码"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">优先级</label>
                <select
                  value={formData.priority_level}
                  onChange={(e) => setFormData({...formData, priority_level: Number(e.target.value) as any})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                >
                  <option value={5}>最高优先级 (5)</option>
                  <option value={4}>高优先级 (4)</option>
                  <option value={3}>中优先级 (3)</option>
                  <option value={2}>低优先级 (2)</option>
                  <option value={1}>最低优先级 (1)</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">当前位置</label>
                <input
                  type="text"
                  value={formData.current_location}
                  onChange={(e) => setFormData({...formData, current_location: e.target.value})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="请输入当前位置"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">目的地</label>
                <input
                  type="text"
                  value={formData.destination}
                  onChange={(e) => setFormData({...formData, destination: e.target.value})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="请输入目的地"
                  required
                />
              </div>
              
              <div className="flex space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="flex-1 py-2 px-4 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex-1 py-2 px-4 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
                >
                  {isLoading ? '提交中...' : '提交请求'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 紧急车辆列表 */}
      <div className="bg-white rounded-lg shadow-md">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-800">紧急车辆列表</h2>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">车辆类型</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">车牌</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">优先级</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">位置</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">目的地</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">请求时间</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {(emergencyVehicles || []).map((vehicle) => (
                <tr key={vehicle.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center mr-3">
                        <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                      </div>
                      <span className="text-sm font-medium text-gray-900">{getVehicleTypeText(vehicle.vehicle_type)}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{vehicle.vehicle_id}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getPriorityColor(vehicle.priority_level)}`}>
                      优先级 {vehicle.priority_level}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">路口 {vehicle.intersection_id}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{vehicle.direction}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(vehicle.status)}`}>
                      {getStatusText(vehicle.status)}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(vehicle.created_at || vehicle.estimated_arrival || '').toLocaleString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <div className="flex space-x-2">
                      {vehicle.status === 0 && (
                        <button
                          onClick={() => cancelEmergency(vehicle.id)}
                          disabled={isLoading}
                          className="text-red-600 hover:text-red-900 text-xs"
                        >
                          取消
                        </button>
                      )}
                      {vehicle.status === 0 && (
                        <>
                          <button
                            onClick={() => completeEmergency(vehicle.id)}
                            disabled={isLoading}
                            className="text-green-600 hover:text-green-900 text-xs"
                          >
                            完成
                          </button>
                          <button
                            onClick={() => cancelEmergency(vehicle.id)}
                            disabled={isLoading}
                            className="text-red-600 hover:text-red-900 text-xs"
                          >
                            取消
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          
          {emergencyVehicles.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              <svg className="w-12 h-12 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p>暂无紧急车辆请求</p>
            </div>
          )}
        </div>
      </div>

      {/* 交通灯状态监控 */}
      <div className="mt-8 bg-white rounded-lg shadow-md">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-800">当前交通灯状态</h2>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {trafficLights.map((light) => (
              <div key={light.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="text-sm font-medium text-gray-700">{light.direction}</span>
                <div className={`w-4 h-4 rounded-full ${
                  light.current_status === 0 ? 'bg-red-500' :
                  light.current_status === 1 ? 'bg-yellow-500' :
                  'bg-green-500'
                }`}></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmergencyManagement;
