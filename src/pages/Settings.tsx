import React, { useState, useEffect, useCallback } from 'react';
import { Save, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';

import { useAiMode } from '@/hooks/useAiMode';
import { intersectionsApi, settingsApi, type IntersectionParams } from '@/lib/api';
import type { Intersection } from '@/types';

interface SystemSettings {
  id: number;
  system_name: string;
  auto_mode: boolean;
  emergency_priority: boolean;
  max_cycle_length: number;
  min_cycle_length: number;
  yellow_light_duration: number;
  detection_radius: number;
  update_interval: number;
  created_at: string;
  updated_at: string;
}

const Settings: React.FC = () => {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [intersections, setIntersections] = useState<{ id: number; name: string }[]>([]);
  const [selectedIntersection, setSelectedIntersection] = useState<number | null>(null);
  const [params, setParams] = useState<IntersectionParams | null>(null);
  // AI 开关逻辑与 Dashboard / TrafficControl / Demo 共用
  const { enabled: aiEnabled, loading: aiLoading, setEnabled: updateAiModeRaw } = useAiMode();

  const updateAiMode = useCallback(
    async (enabled: boolean) => {
      const ok = await updateAiModeRaw(enabled);
      setMessage(
        ok
          ? { type: 'success', text: `AI动态红绿灯${enabled ? '已开启' : '已关闭'}` }
          : { type: 'error', text: '更新AI模式失败' }
      );
      setTimeout(() => setMessage(null), 3000);
    },
    [updateAiModeRaw]
  );

  const fetchSettings = useCallback(async () => {
    try {
      setSettings(await settingsApi.get<SystemSettings>());
    } catch (error) {
      console.error('获取设置失败:', error);
      setMessage({ type: 'error', text: '获取设置失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchIntersections = useCallback(async () => {
    try {
      const list = (await intersectionsApi.list()) as Intersection[];
      setIntersections(list.map((i) => ({ id: i.id, name: i.name })));
      if (list.length > 0) {
        setSelectedIntersection((prev) => (prev === null ? list[0].id : prev));
      }
    } catch {
      /* 路口列表拉取失败不阻塞设置页 */
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchIntersections();
  }, [fetchSettings, fetchIntersections]);

  useEffect(() => {
    const loadParams = async () => {
      if (selectedIntersection == null) return;
      try {
        setParams(await settingsApi.getIntersectionParams(selectedIntersection));
      } catch {}
    };
    loadParams();
  }, [selectedIntersection]);

  const handleSave = async () => {
    if (!settings) return;
    
    setSaving(true);
    setMessage(null);
    
    try {
      await settingsApi.update(settings);
      setMessage({ type: 'success', text: '设置保存成功' });
    } catch (error) {
      console.error('保存设置失败:', error);
      setMessage({ type: 'error', text: '保存设置失败' });
    } finally {
      setSaving(false);
    }

    // 清除消息
    setTimeout(() => setMessage(null), 3000);
  };

  const handleReset = async () => {
    if (!confirm('确定要重置所有设置为默认值吗？')) return;

    try {
      await settingsApi.reset();
      fetchSettings();
      setMessage({ type: 'success', text: '设置已重置为默认值' });
    } catch (error) {
      console.error('重置设置失败:', error);
      setMessage({ type: 'error', text: '重置设置失败' });
    }
  };

  /**
   * 保存路口参数。页面上「路口参数」与「仿真参数」两块表单复用同一个接口，
   * 仅成功提示文案不同，故统一在此处理。
   */
  const handleSaveParams = async (successText: string) => {
    if (!params) return;
    try {
      await settingsApi.updateIntersectionParams(params.intersection_id, params);
      setMessage({ type: 'success', text: successText });
    } catch (error) {
      console.error('保存路口参数失败:', error);
      setMessage({ type: 'error', text: '保存失败' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">无法加载设置</h3>
          <p className="text-gray-500">请检查网络连接或稍后重试</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        {/* 页面标题 */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">系统设置</h1>
          <p className="text-gray-600">配置交通管理系统参数和偏好设置</p>
        </div>

        {/* 消息提示 */}
        {message && (
          <div className={`mb-6 p-4 rounded-lg flex items-center ${
            message.type === 'success' 
              ? 'bg-green-100 text-green-800 border border-green-200' 
              : 'bg-red-100 text-red-800 border border-red-200'
          }`}>
            {message.type === 'success' ? (
              <CheckCircle className="h-5 w-5 mr-2" />
            ) : (
              <AlertCircle className="h-5 w-5 mr-2" />
            )}
            {message.text}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* 基本设置 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-6">基本设置</h2>
            
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">系统名称</label>
                <input
                  type="text"
                  value={settings.system_name}
                  onChange={(e) => setSettings({ ...settings, system_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="输入系统名称"
                />
                <p className="mt-1 text-sm text-gray-500">显示在系统界面和报告中的名称</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="auto_mode"
                    checked={settings.auto_mode}
                    onChange={(e) => setSettings({ ...settings, auto_mode: e.target.checked })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="auto_mode" className="ml-2 block text-sm text-gray-700">启用自动模式</label>
                </div>
                <p className="text-sm text-gray-500 ml-6">允许系统根据车流量自动调整红绿灯时间</p>
              </div>
            </div>
          </div>

          {/* 时间设置 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-6">时间设置</h2>
            
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  最大周期长度 (秒)
                </label>
                <input
                  type="number"
                  min="30"
                  max="300"
                  value={settings.max_cycle_length}
                  onChange={(e) => setSettings({ ...settings, max_cycle_length: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="mt-1 text-sm text-gray-500">
                  红绿灯周期的最大长度
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  黄灯时长 (秒)
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.yellow_light_duration}
                  onChange={(e) => setSettings({ ...settings, yellow_light_duration: parseInt(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="mt-1 text-sm text-gray-500">
                  黄灯持续时间
                </p>
              </div>
            </div>
          </div>

          {/* AI 设置 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-6">AI 智能托管</h2>
            
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                   <h3 className="text-base font-medium text-gray-900">AI 动态红绿灯</h3>
                   <p className="text-sm text-gray-500 mt-1">允许 AI 根据实时车流量自动调整绿灯时长</p>
                </div>
                <button
                  onClick={() => updateAiMode(!aiEnabled)}
                  disabled={aiLoading}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                    aiEnabled ? 'bg-blue-600' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      aiEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-6">路口参数</h2>
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">选择路口</label>
                <select
                  value={selectedIntersection ?? ''}
                  onChange={(e) => setSelectedIntersection(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {intersections.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>
              {params && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">低流量检测窗口 (秒)</label>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={params.window_seconds}
                      onChange={(e) => setParams({ ...params, window_seconds: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">强制降级阈值 (辆)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={params.low_flow_threshold}
                      onChange={(e) => setParams({ ...params, low_flow_threshold: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <p className="mt-1 text-xs text-gray-500">当相位总车数低于此值时，绿灯将被限制为最短时长</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">最短绿灯时长 (秒)</label>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={params.min_green_floor}
                      onChange={(e) => setParams({ ...params, min_green_floor: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      onClick={async () => {
                        await handleSaveParams('路口参数已保存');
                      }}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    >
                      保存路口参数
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 仿真参数设置 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-6">交通仿真参数</h2>
            <div className="space-y-6">
              {params ? (
                <>
                  <div className="space-y-4">
                    <h3 className="text-sm font-medium text-gray-700 border-b pb-2">车辆生成速率倍率 (Arrival Rate)</h3>
                    <div>
                      <div className="flex justify-between mb-1">
                        <label className="text-sm text-gray-600">直行生成倍率</label>
                        <span className="text-sm font-medium text-blue-600">{params.arrival_straight_scale ?? 0.3}x</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        value={params.arrival_straight_scale ?? 0.3}
                        onChange={(e) => setParams({ ...params, arrival_straight_scale: parseFloat(e.target.value) })}
                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between mb-1">
                        <label className="text-sm text-gray-600">左转生成倍率</label>
                        <span className="text-sm font-medium text-blue-600">{params.arrival_left_scale ?? 0.2}x</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        value={params.arrival_left_scale ?? 0.2}
                        onChange={(e) => setParams({ ...params, arrival_left_scale: parseFloat(e.target.value) })}
                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  </div>

                  <div className="space-y-4 pt-4">
                    <h3 className="text-sm font-medium text-gray-700 border-b pb-2">车辆通行效率倍率 (Release Rate)</h3>
                    <div>
                      <div className="flex justify-between mb-1">
                        <label className="text-sm text-gray-600">直行通行倍率</label>
                        <span className="text-sm font-medium text-green-600">{params.release_straight_scale ?? 0.8}x</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        value={params.release_straight_scale ?? 0.8}
                        onChange={(e) => setParams({ ...params, release_straight_scale: parseFloat(e.target.value) })}
                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between mb-1">
                        <label className="text-sm text-gray-600">左转通行倍率</label>
                        <span className="text-sm font-medium text-green-600">{params.release_left_scale ?? 0.7}x</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        value={params.release_left_scale ?? 0.7}
                        onChange={(e) => setParams({ ...params, release_left_scale: parseFloat(e.target.value) })}
                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end pt-4">
                    <button
                      onClick={async () => {
                        await handleSaveParams('仿真参数已更新');
                      }}
                      className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                    >
                      更新仿真配置
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-gray-500 text-center py-4">请先选择路口以配置仿真参数</div>
              )}
            </div>
          </div>

          {/* 系统信息 */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-6">系统信息</h2>
            
            <div className="space-y-4">
              <div className="flex justify-between py-2 border-b border-gray-200">
                <span className="text-sm text-gray-600">创建时间:</span>
                <span className="text-sm text-gray-900">
                  {new Date(settings.created_at).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between py-2 border-b border-gray-200">
                <span className="text-sm text-gray-600">最后更新:</span>
                <span className="text-sm text-gray-900">
                  {new Date(settings.updated_at).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-sm text-gray-600">系统版本:</span>
                <span className="text-sm text-gray-900">v1.0.0</span>
              </div>
            </div>

            <div className="mt-6 pt-6 border-t border-gray-200">
              <button
                onClick={handleReset}
                className="w-full flex items-center justify-center px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                重置为默认值
              </button>
            </div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="mt-8 flex justify-end space-x-4">
          <button
            onClick={fetchSettings}
            className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            disabled={saving}
          >
            刷新
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                保存中...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                保存设置
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Settings;
