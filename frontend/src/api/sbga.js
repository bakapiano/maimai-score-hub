import httpRequest from '../request/index'

async function qrcode(qrcode) {
  return await httpRequest.post('/qrcode/', { qrcode })
}

async function logout(uid) {
  return await httpRequest.post('/logout/', { uid })
}

export { qrcode, logout }