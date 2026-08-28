import React, { useState, useEffect } from 'react';
import { Bell, User, AlertTriangle, Clock, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { io, Socket } from 'socket.io-client';

const Header: React.FC = () => {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [emergencyMode, setEmergencyMode] = useState(false);
  const [notifications, setNotifications] = useState(0);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    // 更新时间
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    // 连接WebSocket
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('emergencyMode', (data) => {
      setEmergencyMode(data === 'emergency');
    });


    const savedAvatar = localStorage.getItem('user_avatar');
    if (savedAvatar) setAvatarPreview(savedAvatar);
    return () => {
      clearInterval(timer);
      newSocket.close();
    };
  }, []);

  const formatTime = (date: Date) => {
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <header className="bg-white shadow-sm border-b border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        {/* 左侧标题 */}
        <div className="flex items-center space-x-4">
          <h1 className="text-2xl font-bold text-gray-900">智能交通管理系统</h1>
          {emergencyMode && (
            <div className="flex items-center px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-medium">
              <AlertTriangle className="h-4 w-4 mr-1" />
              紧急模式
            </div>
          )}
        </div>

        {/* 右侧信息 */}
        <div className="flex items-center space-x-6">
          {/* 系统时间 */}
          <div className="flex items-center text-gray-600">
            <Clock className="h-5 w-5 mr-2" />
            <span className="text-sm font-medium">{formatTime(currentTime)}</span>
          </div>

          {/* 通知 */}
          <div className="relative">
            <button className="p-2 text-gray-400 hover:text-gray-600 transition-colors relative">
              <Bell className="h-5 w-5" />
              {notifications > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
                  {notifications > 99 ? '99+' : notifications}
                </span>
              )}
            </button>
          </div>

          {/* 用户菜单 */}
          <div className="flex items-center space-x-3">
            <div className="text-right">
              <div className="text-sm font-medium text-gray-900">管理员</div>
              <div className="text-xs text-gray-500">在线</div>
            </div>
            <button
              className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center overflow-hidden"
              onClick={() => setShowProfile(true)}
              title="编辑个人资料"
            >
              {avatarPreview ? (
                <img src={avatarPreview} alt="avatar" className="w-full h-full object-cover" />
              ) : (
                <User className="h-4 w-4 text-white" />
              )}
            </button>
            <button
              className="ml-4 px-3 py-1 rounded-md bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm"
              onClick={async () => {
                const token = localStorage.getItem('auth_token')
                if (token) {
                  await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ token })
                  }).catch(() => {})
                }
                localStorage.removeItem('auth_token');
                window.location.href = '/login';
              }}
            >
              退出登录
            </button>
          </div>
        </div>
      </div>
      {showProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowProfile(false)}></div>
          <div className="relative w-full max-w-md bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="text-lg font-semibold text-gray-900">编辑个人资料</div>
              <button className="text-gray-500 hover:text-gray-700" onClick={() => setShowProfile(false)}>×</button>
            </div>
            {errorMsg && <div className="mb-3 p-2 rounded bg-red-100 text-red-800 text-sm">{errorMsg}</div>}
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium text-gray-700 mb-2">头像</div>
                <div className="flex items-center space-x-4">
                  <div className="w-16 h-16 rounded-full overflow-hidden bg-gray-200 flex items-center justify-center">
                    {avatarPreview ? (
                      <img src={avatarPreview} alt="avatar" className="w-full h-full object-cover" />
                    ) : (
                      <User className="h-6 w-6 text-gray-500" />
                    )}
                  </div>
                  <label className="inline-flex items-center px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm cursor-pointer">
                    <Pencil className="h-4 w-4 mr-2" />更换头像
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          const url = String(reader.result);
                          setAvatarPreview(url);
                        };
                        reader.readAsDataURL(f);
                      }}
                    />
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">新密码</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="至少6位"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">确认新密码</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end space-x-3">
              <button className="px-4 py-2 rounded-md bg-gray-200 hover:bg-gray-300 text-gray-800" onClick={() => setShowProfile(false)}>取消</button>
              <button
                className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white"
                onClick={() => {
                  setErrorMsg('');
                  if (newPassword && newPassword.length < 6) { setErrorMsg('密码长度至少6位'); return; }
                  if (newPassword && newPassword !== confirmPassword) { setErrorMsg('两次输入的密码不一致'); return; }
                  // avatar save placeholder
                  toast('功能开发中');
                  setShowProfile(false);
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

export default Header;
