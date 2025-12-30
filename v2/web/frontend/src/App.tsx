import './App.css'

import { useEffect, useMemo, useState } from 'react'

type User = {
  _id: string
  friendCode: string
  createdAt?: string
  updatedAt?: string
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, init)
  const text = await res.text()
  const data = text ? (JSON.parse(text) as T) : (null as T)
  return { ok: res.ok, status: res.status, data }
}

function App() {
  const [health, setHealth] = useState<string>('')
  const [users, setUsers] = useState<User[]>([])
  const [createFriendCode, setCreateFriendCode] = useState('')
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editingFriendCode, setEditingFriendCode] = useState('')
  const [result, setResult] = useState<string>('')

  const canCreate = useMemo(
    () => createFriendCode.trim().length > 0,
    [createFriendCode],
  )

  const canSave = useMemo(
    () => !!editingUserId && editingFriendCode.trim().length > 0,
    [editingUserId, editingFriendCode],
  )

  const refreshUsers = async () => {
    const res = await fetchJson<User[]>('/api/users')
    if (res.ok && Array.isArray(res.data)) {
      setUsers(res.data)
    }
  }

  useEffect(() => {
    ;(async () => {
      const res = await fetchJson<{ status?: string }>('/api/health')
      setHealth(res.ok ? JSON.stringify(res.data) : `HTTP ${res.status}`)
      await refreshUsers()
    })()
  }, [])

  const createUser = async () => {
    setResult('')
    const res = await fetchJson<unknown>('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendCode: createFriendCode.trim() }),
    })

    setResult(JSON.stringify(res.data, null, 2))
    if (res.ok) {
      setCreateFriendCode('')
      await refreshUsers()
    }
  }

  const startEdit = (user: User) => {
    setEditingUserId(user._id)
    setEditingFriendCode(user.friendCode)
  }

  const cancelEdit = () => {
    setEditingUserId(null)
    setEditingFriendCode('')
  }

  const saveEdit = async () => {
    if (!editingUserId) return

    setResult('')
    const res = await fetchJson<unknown>(`/api/users/${editingUserId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendCode: editingFriendCode.trim() }),
    })

    setResult(JSON.stringify(res.data, null, 2))
    if (res.ok) {
      cancelEdit()
      await refreshUsers()
    }
  }

  const deleteUser = async (id: string) => {
    setResult('')
    const res = await fetchJson<unknown>(`/api/users/${id}`, { method: 'DELETE' })
    setResult(JSON.stringify(res.data, null, 2))
    if (res.ok) {
      if (editingUserId === id) {
        cancelEdit()
      }
      await refreshUsers()
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '24px auto', padding: '0 16px' }}>
      <h1>v2 web</h1>

      <div className="card" style={{ textAlign: 'left' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Backend health</div>
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{health}</pre>
      </div>

      <div className="card" style={{ textAlign: 'left' }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Users (CRUD)</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <label>
            Friend Code
            <input
              value={createFriendCode}
              onChange={(e) => setCreateFriendCode(e.target.value)}
              style={{ marginLeft: 8 }}
              placeholder="e.g. 634142510810999"
            />
          </label>
          <button onClick={createUser} disabled={!canCreate}>
            Create User
          </button>
          <button onClick={refreshUsers}>Refresh</button>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Edit</div>
          {editingUserId ? (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ opacity: 0.8 }}>ID: {editingUserId}</div>
              <label>
                Friend Code
                <input
                  value={editingFriendCode}
                  onChange={(e) => setEditingFriendCode(e.target.value)}
                  style={{ marginLeft: 8 }}
                />
              </label>
              <button onClick={saveEdit} disabled={!canSave}>
                Save
              </button>
              <button onClick={cancelEdit}>Cancel</button>
            </div>
          ) : (
            <div style={{ opacity: 0.7 }}>Select a user to edit.</div>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Result</div>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result}</pre>
        </div>
      </div>

      <div className="card" style={{ textAlign: 'left' }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Users</div>
        {users.length ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {users.map((u) => (
              <div
                key={u._id}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{u.friendCode}</div>
                  <div style={{ opacity: 0.7, fontSize: 12, wordBreak: 'break-all' }}>
                    {u._id}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button onClick={() => startEdit(u)}>Edit</button>
                  <button onClick={() => deleteUser(u._id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ opacity: 0.7 }}>No users yet.</div>
        )}
      </div>
    </div>
  )
}

export default App
