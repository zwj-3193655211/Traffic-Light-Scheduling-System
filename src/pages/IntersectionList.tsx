import React, { useState, useEffect } from 'react';

import type { Intersection } from '@/types';

type IntersectionFormData = {
  name: string;
  latitude: number;
  longitude: number;
  status: number;
  next_north_id: number | null;
  next_south_id: number | null;
  next_east_id: number | null;
  next_west_id: number | null;
}

const IntersectionList: React.FC = () => {
  const [intersections, setIntersections] = useState<Intersection[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingIntersection, setEditingIntersection] = useState<Intersection | null>(null);
  const [formData, setFormData] = useState<IntersectionFormData>({
    name: '',
    latitude: 0,
    longitude: 0,
    status: 1 as number,
    next_north_id: null as number | null,
    next_south_id: null as number | null,
    next_east_id: null as number | null,
    next_west_id: null as number | null,
  });

  useEffect(() => {
    fetchIntersections();
    const bc = new BroadcastChannel('intersections_update');
    bc.onmessage = (event) => {
      if (event.data?.type === 'updated') {
        fetchIntersections();
      }
    };
    return () => bc.close();
  }, []);

  const fetchIntersections = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/intersections?include_maintenance=1&ts=${Date.now()}`);
      const json = await response.json();
      setIntersections(json.data || []);
    } catch (error) {
      console.error('获取路口信息失败:', error);
      setMessage('获取路口信息失败');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      const url = editingIntersection 
        ? `/api/intersections/${editingIntersection.id}`
        : '/api/intersections';
      const method = editingIntersection ? 'PUT' : 'POST';

      const body = editingIntersection
        ? JSON.stringify({
            name: formData.name,
            latitude: formData.latitude,
            longitude: formData.longitude,
            status: formData.status,
            next_north_id: formData.next_north_id,
            next_south_id: formData.next_south_id,
            next_east_id: formData.next_east_id,
            next_west_id: formData.next_west_id,
          })
        : JSON.stringify({
            name: formData.name,
            latitude: formData.latitude,
            longitude: formData.longitude,
            status: formData.status,
            next_north_id: formData.next_north_id,
            next_south_id: formData.next_south_id,
            next_east_id: formData.next_east_id,
            next_west_id: formData.next_west_id,
          });

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body,
      });

      if (response.ok) {
        const respJson = await response.json().catch(() => ({} as any));
        setMessage(editingIntersection ? '路口信息更新成功' : '路口创建成功');
        setShowForm(false);
        setEditingIntersection(null);
        setFormData({ name: '', latitude: 0, longitude: 0, status: 1, next_north_id: null, next_south_id: null, next_east_id: null, next_west_id: null });
        // 乐观更新本地列表
        setIntersections((prev) => {
          if (editingIntersection) {
            return prev.map(i => i.id === editingIntersection.id ? {
              ...i,
              name: formData.name,
              latitude: formData.latitude,
              longitude: formData.longitude,
              status: formData.status,
              next_north_id: formData.next_north_id,
              next_south_id: formData.next_south_id,
              next_east_id: formData.next_east_id,
              next_west_id: formData.next_west_id,
            } : i)
          }
          const created = (respJson && respJson.data) ? respJson.data : null
          if (created) {
            const exists = prev.some(i => i.id === created.id)
            if (exists) return prev
            return [{
              id: created.id,
              name: created.name,
              latitude: created.latitude,
              longitude: created.longitude,
              status: created.status,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              next_north_id: created.next_north_id,
              next_south_id: created.next_south_id,
              next_east_id: created.next_east_id,
              next_west_id: created.next_west_id,
            }, ...prev]
          }
          return prev
        })
        // 重新拉取最新列表并通知其他页面
        fetchIntersections();
        try { new BroadcastChannel('intersections_update').postMessage({ type: editingIntersection ? 'update' : 'create', id: editingIntersection ? editingIntersection.id : (respJson?.data?.id) }) } catch {}
        setTimeout(() => setMessage(''), 3000);
      } else {
        const error = await response.json();
        setMessage(`操作失败: ${error.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } catch (error) {
      setMessage('网络错误，请稍后重试');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const editIntersection = (intersection: Intersection) => {
    setEditingIntersection(intersection);
    setFormData({
      name: intersection.name,
      latitude: intersection.latitude,
      longitude: intersection.longitude,
      status: typeof intersection.status === 'string' ? (intersection.status === 'active' ? 1 : 0) : intersection.status as number,
      next_north_id: intersection.next_north_id ?? null,
      next_south_id: intersection.next_south_id ?? null,
      next_east_id: intersection.next_east_id ?? null,
      next_west_id: intersection.next_west_id ?? null,
    });
    setShowForm(true);
  };

  const deleteIntersection = async (id: number) => {
    if (!confirm('确定要删除这个路口吗？此操作不可恢复。')) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`/api/intersections/${id}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setMessage('路口删除成功');
        // 本地删除
        setIntersections(prev => prev.filter(i => i.id !== id))
        fetchIntersections();
        try { new BroadcastChannel('intersections_update').postMessage({ type: 'delete', id }) } catch {}
        setTimeout(() => setMessage(''), 3000);
      } else {
        const error = await response.json();
        setMessage(`删除失败: ${error.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } catch (error) {
      setMessage('网络错误，请稍后重试');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleStatus = async (id: number, currentStatus: number | string) => {
    const normalized = typeof currentStatus === 'string' ? (currentStatus === 'active' ? 1 : 0) : (currentStatus as number);
    const newStatus = normalized === 1 ? 0 : 1;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/intersections/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: newStatus }),
      });

      if (response.ok) {
        setMessage(`路口状态已更新为${newStatus === 1 ? '活跃' : '维护中'}`);
        // 本地更新状态
        setIntersections(prev => prev.map(i => i.id === id ? { ...i, status: newStatus } : i))
        fetchIntersections();
        try { new BroadcastChannel('intersections_update').postMessage({ type: 'status', id, status: newStatus }) } catch {}
        setTimeout(() => setMessage(''), 3000);
      } else {
        const error = await response.json();
        setMessage(`状态更新失败: ${error.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } catch (error) {
      setMessage('网络错误，请稍后重试');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusColor = (status: number | string) => {
    const normalized = typeof status === 'string' ? (status === 'active' ? 1 : 0) : (status as number);
    switch (normalized) {
      case 1: return 'bg-green-100 text-green-800';
      case 0: return 'bg-yellow-100 text-yellow-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusText = (status: number | string) => {
    const normalized = typeof status === 'string' ? (status === 'active' ? 1 : 0) : (status as number);
    switch (normalized) {
      case 1: return '活跃';
      case 0: return '维护中';
      default: return String(status);
    }
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-800 mb-2">路口管理</h1>
          <p className="text-gray-600">管理和配置交通路口信息</p>
        </div>
        <button
          onClick={() => {
            setEditingIntersection(null);
            setFormData({ name: '', latitude: 0, longitude: 0, status: 1, next_north_id: null, next_south_id: null, next_east_id: null, next_west_id: null });
            setShowForm(true);
          }}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 flex items-center"
        >
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          新增路口
        </button>
      </div>

      {/* 消息提示 */}
      {message && (
        <div className={`mb-4 p-4 rounded-lg border ${
          message.includes('成功') || message.includes('已更新') 
            ? 'bg-green-100 text-green-800 border-green-200' 
            : 'bg-red-100 text-red-800 border-red-200'
        }`}>
          {message}
        </div>
      )}

      {/* 路口表单模态框 */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-gray-800">
                {editingIntersection ? '编辑路口' : '新增路口'}
              </h2>
              <button
                onClick={() => {
                  setShowForm(false);
                  setEditingIntersection(null);
                }}
                className="text-gray-500 hover:text-gray-700"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">路口名称</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="请输入路口名称"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">纬度</label>
                <input
                  type="number"
                  value={formData.latitude}
                  onChange={(e) => setFormData({...formData, latitude: Number(e.target.value)})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="例如: 39.9042"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">经度</label>
                <input
                  type="number"
                  value={formData.longitude}
                  onChange={(e) => setFormData({...formData, longitude: Number(e.target.value)})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="例如: 116.4074"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({...formData, status: Number(e.target.value)})}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value={1}>活跃</option>
                  <option value={0}>维护中</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">北向下一路口</label>
                <select
                  value={formData.next_north_id ?? ''}
                  onChange={(e) => setFormData({ ...formData, next_north_id: e.target.value ? Number(e.target.value) : null })}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">无</option>
                  {intersections.map(i => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">南向下一路口</label>
                <select
                  value={formData.next_south_id ?? ''}
                  onChange={(e) => setFormData({ ...formData, next_south_id: e.target.value ? Number(e.target.value) : null })}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">无</option>
                  {intersections.map(i => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">东向下一路口</label>
                <select
                  value={formData.next_east_id ?? ''}
                  onChange={(e) => setFormData({ ...formData, next_east_id: e.target.value ? Number(e.target.value) : null })}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">无</option>
                  {intersections.map(i => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">西向下一路口</label>
                <select
                  value={formData.next_west_id ?? ''}
                  onChange={(e) => setFormData({ ...formData, next_west_id: e.target.value ? Number(e.target.value) : null })}
                  className="w-full p-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">无</option>
                  {intersections.map(i => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setEditingIntersection(null);
                  }}
                  className="flex-1 py-2 px-4 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex-1 py-2 px-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
                >
                  {isLoading ? '提交中...' : (editingIntersection ? '更新' : '创建')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 路口列表 */}
      <div className="bg-white rounded-lg shadow-md">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-800">路口列表</h2>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">名称</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">坐标</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">创建时间</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {intersections.map((intersection) => (
                <tr key={intersection.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{intersection.name}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{intersection.latitude}, {intersection.longitude}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(intersection.status)}`}>
                      {getStatusText(intersection.status)}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(intersection.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <div className="flex space-x-2">
                      <button
                        onClick={() => toggleStatus(intersection.id, intersection.status)}
                        disabled={isLoading}
                        className="text-blue-600 hover:text-blue-900 text-xs"
                      >
                        {(typeof intersection.status === 'string' ? intersection.status === 'active' : intersection.status === 1) ? '设为维护' : '设为活跃'}
                      </button>
                      <button
                        onClick={() => editIntersection(intersection)}
                        disabled={isLoading}
                        className="text-green-600 hover:text-green-900 text-xs"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => deleteIntersection(intersection.id)}
                        disabled={isLoading}
                        className="text-red-600 hover:text-red-900 text-xs"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          
          {intersections.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              <svg className="w-12 h-12 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <p>暂无路口信息</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default IntersectionList;
