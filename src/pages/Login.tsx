import React, { useState } from 'react'

const Login: React.FC = () => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok || !json?.success) {
        setError(json?.message || '账号或密码错误')
        return
      }
      const token = json?.data?.token
      if (!token) {
        setError('登录失败')
        return
      }
      localStorage.setItem('auth_token', token)
      window.location.href = '/'
    } catch {
      setError('网络错误，请稍后重试')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">登录</h1>
        {error && (
          <div className="mb-4 p-3 rounded bg-red-100 text-red-800 text-sm">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">账号</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="admin"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="123456"
            />
          </div>
          <button
            type="submit"
            className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
          >
            登录
          </button>
        </form>
        <div className="mt-4 text-xs text-gray-500">
          默认账号: admin，默认密码: 123456
        </div>
      </div>
    </div>
  )
}

export default Login
