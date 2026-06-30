const mineflayer = require('mineflayer')
const readline = require('readline')
const { exec } = require('child_process')
const { Vec3 } = require('vec3')

const HOST = 'rune.pikamc.vn'
const PORT = 25078
const USERNAME = 'lamthanh'
const PASSWORD = 'matkhau123'
const VERSION = '1.20.1'

const scriptStartTime = Date.now()
let bot = null
let connectedSince = null
let registered = false
let loggedIn = false

let reconnectAttempts = 0
let totalReconnects = 0
let reconnecting = false
let shuttingDown = false
let reconnectTimeoutId = null
let nextReconnectAt = null

let afkTimeout = null
let reportInterval = null
let autoShutdownTimeout = null
let idleHeartbeat = null

// ===== Wake-lock Termux =====
function acquireWakeLock() {
  exec('termux-wake-lock', (err) => {
    if (err) console.log('⚠️ Không gọi được termux-wake-lock — cần pkg install termux-api + app Termux:API.')
    else console.log('🔒 Đã giữ wake-lock.')
  })
}
function releaseWakeLock() {
  exec('termux-wake-unlock', () => {})
}

// ===== Tiện ích =====
function formatDuration(ms) {
  const min = Math.floor(ms / 60000)
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h${m}m` : `${m}m`
}
function memUsageMB() {
  return (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
}

// ===== Dọn bot cũ hoàn toàn =====
function destroyBot() {
  if (bot) {
    try { bot.removeAllListeners() } catch (e) {}
    try { bot.end() }               catch (e) {}
    bot = null
  }
}

// ===== Tự nghỉ theo giờ VN =====
function msUntilNextVNHour(targetHour) {
  const vnOffsetMs = 7 * 60 * 60 * 1000
  const now = new Date()
  const nowVN = new Date(now.getTime() + vnOffsetMs)
  const target = new Date(Date.UTC(
    nowVN.getUTCFullYear(), nowVN.getUTCMonth(), nowVN.getUTCDate(),
    targetHour, 0, 0
  ))
  if (nowVN.getTime() >= target.getTime()) target.setUTCDate(target.getUTCDate() + 1)
  return target.getTime() - nowVN.getTime()
}

function scheduleAutoShutdown(targetHour = 5) {
  if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout)
  const delay = msUntilNextVNHour(targetHour)
  console.log(`🕐 Bot sẽ tự nghỉ sau ${(delay / 3600000).toFixed(2)} giờ (lúc ${targetHour}:00 VN)`)
  autoShutdownTimeout = setTimeout(() => goIdle(`Đã đến ${targetHour}:00 sáng VN`), delay)
}

// ===== Idle / Wake =====
function goIdle(reason) {
  shuttingDown = true
  connectedSince = null
  registered = false
  loggedIn = false
  console.log(`🌙 ${reason} → Ngắt kết nối, chuyển sang chế độ nghỉ.`)
  console.log('💤 Gõ "wake" để bật lại.')

  stopWall('Bot chuyển sang nghỉ')
  if (afkTimeout)          clearTimeout(afkTimeout)
  if (reportInterval)      clearInterval(reportInterval)
  if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout)
  if (reconnectTimeoutId)  clearTimeout(reconnectTimeoutId)
  nextReconnectAt = null

  destroyBot()
  releaseWakeLock()

  if (idleHeartbeat) clearInterval(idleHeartbeat)
  idleHeartbeat = setInterval(() => {
    console.log(`💤 [${new Date().toLocaleTimeString()}] Đang nghỉ — gõ "wake" để bật lại.`)
  }, 1800000)
}

function wake() {
  if (!shuttingDown) { console.log('ℹ️ Bot đang hoạt động, không cần wake.'); return }
  console.log('🌞 Đang bật lại bot...')
  shuttingDown = false
  reconnectAttempts = 0
  if (idleHeartbeat) clearInterval(idleHeartbeat)
  acquireWakeLock()
  scheduleAutoShutdown(5)
  connect()
}

function forceReconnect() {
  if (shuttingDown) { console.log('⚠️ Bot đang nghỉ. Gõ "wake" trước.'); return }
  console.log('🔄 Buộc kết nối lại ngay...')
  stopWall('Reconnect')
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null }
  nextReconnectAt = null
  reconnecting = true
  destroyBot()
  reconnectAttempts = 0
  setTimeout(() => { reconnecting = false; connect() }, 1000)
}

// ===== Reconnect =====
function scheduleReconnect() {
  if (reconnecting || shuttingDown) return
  reconnecting = true
  if (afkTimeout)     clearTimeout(afkTimeout)
  if (reportInterval) clearInterval(reportInterval)

  const delay = Math.min(10000 * Math.pow(1.5, reconnectAttempts), 300000)
  reconnectAttempts++
  totalReconnects++
  nextReconnectAt = Date.now() + delay
  console.log(`⏳ Chờ ${Math.round(delay / 1000)}s rồi kết nối lại (lần ${reconnectAttempts})...`)

  reconnectTimeoutId = setTimeout(() => {
    nextReconnectAt = null
    reconnecting = false
    reconnectTimeoutId = null
    connect()
  }, delay)
}

// ===== Anti-AFK =====
function scheduleAfk() {
  if (afkTimeout) clearTimeout(afkTimeout)
  const delay = 45000 + Math.random() * 55000
  afkTimeout = setTimeout(() => {
    doAfkAction()
    scheduleAfk()
  }, delay)
}

function doAfkAction() {
  if (!bot || !loggedIn) return
  if (wallTask) return // đang xây thì không xen vào điều khiển
  const yaw   = Math.random() * Math.PI * 2
  const pitch = (Math.random() * 40 - 20) * (Math.PI / 180)
  try { bot.look(yaw, pitch, false) } catch (e) {}

  if (Math.random() < 0.3) {
    try {
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch(e){} }, 300)
    } catch (e) {}
  }

  try {
    bot.setControlState('forward', true)
    setTimeout(() => { try { bot.setControlState('forward', false) } catch(e){} }, 200 + Math.random() * 200)
  } catch (e) {}
}

// ================== TÍNH NĂNG: GOTO + XÂY TƯỜNG ==================
// goto <x> <z>  -> bot đi theo trục X rồi trục Z (không đi chéo),
// tự nhảy qua bậc cao, tự lấp hố/dốc xuống, và đặt block tường
// (cao 1) dọc theo đường vừa đi qua.

let wallTask = null      // { targetX, targetZ, phase, placed, lastReported, active }
let wallInterval = null
let wallBusy = false

function pickBuildBlock() {
  if (!bot) return null
  const preferred = ['cobblestone', 'stone', 'cobbled_deepslate', 'andesite', 'netherrack', 'dirt']
  for (const name of preferred) {
    const item = bot.inventory.items().find(i => i.name === name)
    if (item) return item
  }
  // fallback: bất kỳ item nào trông giống block xây dựng được
  return bot.inventory.items().find(i =>
    /(_planks|stone|dirt|deepslate|blackstone|concrete|terracotta|log|bricks?|cobblestone)$/i.test(i.name)
  ) || null
}

async function placeBlockAt(pos) {
  if (!bot) return false
  const existing = bot.blockAt(pos)
  if (existing && existing.boundingBox === 'block') return true // đã có sẵn rồi

  const item = pickBuildBlock()
  if (!item) {
    console.log('⚠️ Hết block để xây trong túi đồ! Tạm dừng goto.')
    stopWall('Hết block')
    return false
  }

  const offsets = [
    [0, -1, 0, new Vec3(0, 1, 0)],
    [1, 0, 0, new Vec3(-1, 0, 0)],
    [-1, 0, 0, new Vec3(1, 0, 0)],
    [0, 0, 1, new Vec3(0, 0, -1)],
    [0, 0, -1, new Vec3(0, 0, 1)],
  ]
  for (const [ox, oy, oz, face] of offsets) {
    const refBlock = bot.blockAt(pos.offset(ox, oy, oz))
    if (refBlock && refBlock.boundingBox === 'block') {
      try {
        await bot.equip(item, 'hand')
        await bot.placeBlock(refBlock, face)
        return true
      } catch (e) {
        continue
      }
    }
  }
  return false
}

function startGoto(xStr, zStr) {
  const x = parseInt(xStr, 10)
  const z = parseInt(zStr, 10)
  if (Number.isNaN(x) || Number.isNaN(z)) { console.log('⚠️ Cú pháp: goto <x> <z>'); return }
  if (!bot || !bot.entity) { console.log('⚠️ Bot chưa sẵn sàng (chưa vào server).'); return }
  if (wallTask) stopWall('Có lệnh goto mới')

  wallTask = { targetX: x, targetZ: z, phase: 'x', placed: 0, lastReported: 0, active: true }
  console.log(`🚧 Bắt đầu di chuyển + xây tới (${x}, ${z})...`)
  if (wallInterval) clearInterval(wallInterval)
  wallInterval = setInterval(wallTick, 350)
}

function stopWall(reason, silent) {
  if (wallInterval) { clearInterval(wallInterval); wallInterval = null }
  if (bot) { try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch (e) {} }
  if (wallTask && !silent) {
    console.log(`⏹️ Dừng xây${reason ? ' (' + reason + ')' : ''}. Đã đặt ${wallTask.placed} block.`)
  }
  wallTask = null
}

function finishWall() {
  console.log(`✅ Đã đến nơi! Tổng cộng đặt ${wallTask ? wallTask.placed : 0} block.`)
  stopWall(null, true)
}

async function wallTick() {
  if (!wallTask || !wallTask.active || wallBusy) return
  if (!bot || !bot.entity) return
  wallBusy = true
  try {
    const pos = bot.entity.position
    const curX = Math.floor(pos.x)
    const curZ = Math.floor(pos.z)
    const footY = Math.floor(pos.y)

    if (wallTask.phase === 'x' && curX === wallTask.targetX) wallTask.phase = 'z'
    if (curX === wallTask.targetX && curZ === wallTask.targetZ) {
      finishWall()
      wallBusy = false
      return
    }

    let dx = 0, dz = 0
    if (wallTask.phase === 'x') dx = wallTask.targetX > curX ? 1 : -1
    else dz = wallTask.targetZ > curZ ? 1 : -1

    const yaw = Math.atan2(-dx, dz)
    bot.look(yaw, 0, true)

    const nextX = curX + dx, nextZ = curZ + dz
    const groundNext = bot.blockAt(new Vec3(nextX, footY - 1, nextZ))
    const feetNext = bot.blockAt(new Vec3(nextX, footY, nextZ))

    // 1) Hố/dốc xuống phía trước → lấp trước khi bước qua
    if (groundNext && groundNext.boundingBox !== 'block') {
      const ok = await placeBlockAt(new Vec3(nextX, footY - 1, nextZ))
      if (ok) wallTask.placed++
      wallBusy = false
      return
    }

    // 2) Bậc cao chắn ngang chân (dốc lên) → tự nhảy
    if (feetNext && feetNext.boundingBox === 'block') {
      bot.setControlState('jump', true)
      setTimeout(() => { try { bot.setControlState('jump', false) } catch (e) {} }, 250)
    }

    // 3) Bước tới
    bot.setControlState('forward', true)
    setTimeout(() => { try { bot.setControlState('forward', false) } catch (e) {} }, 280)

    // 4) Xây block tường tại ô vừa rời đi (phía sau lưng), không tự chặn đường đi
    setTimeout(async () => {
      try {
        const wallPos = new Vec3(curX, footY, curZ)
        const already = bot.blockAt(wallPos)
        if (already && already.boundingBox !== 'block') {
          const ok = await placeBlockAt(wallPos)
          if (ok && wallTask) wallTask.placed++
        }
      } catch (e) {}
    }, 320)

    if (wallTask.placed > 0 && wallTask.placed % 50 === 0 && wallTask.placed !== wallTask.lastReported) {
      wallTask.lastReported = wallTask.placed
      console.log(`🧱 Đã đặt ${wallTask.placed} block | Đang ở (${curX}, ${footY}, ${curZ}) | Đích (${wallTask.targetX}, ${wallTask.targetZ})`)
    }
  } catch (e) {
    console.log('❌ Lỗi trong lúc xây:', e.message)
  }
  wallBusy = false
}
// ================== HẾT PHẦN GOTO + XÂY TƯỜNG ==================

// ===== CONNECT =====
function connect() {
  destroyBot()
  registered = false
  loggedIn = false
  connectedSince = null

  if (reportInterval) clearInterval(reportInterval)
  if (afkTimeout)     clearTimeout(afkTimeout)

  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: 'offline',
    viewDistance: 5,
    checkTimeoutInterval: 30000,
    closeTimeout: 30000,
  })

  let endHandled = false
  function handleDisconnect(reason) {
    if (endHandled) return
    endHandled = true
    connectedSince = null
    registered = false
    loggedIn = false
    stopWall('Mất kết nối')
    if (afkTimeout)     clearTimeout(afkTimeout)
    if (reportInterval) clearInterval(reportInterval)
    if (!shuttingDown) scheduleReconnect()
  }

  bot.on('spawn', () => {
    connectedSince = Date.now()
    reconnectAttempts = 0
    console.log('✅ Bot đã vào server')
    scheduleAfk()

    reportInterval = setInterval(() => {
      if (!bot) return
      const pos = bot.entity ? bot.entity.position : null
      const posStr = pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : '?'
      const chunkCount = Object.keys(bot.world.columns || {}).length
      console.log(`📊 [${new Date().toLocaleTimeString()}] RAM: ${memUsageMB()}MB | Online: ${formatDuration(Date.now() - connectedSince)} | Chunk: ${chunkCount} | Pos: ${posStr}`)
    }, 15000)
  })

  function handleMessage(text) {
    if (!text) return

    if (!registered && /register|đăng ký/i.test(text) && !/đã đăng ký/i.test(text)) {
      registered = true
      setTimeout(() => { try { bot.chat(`/register ${PASSWORD} ${PASSWORD}`) } catch(e){} }, 2500)
    }
    if (!loggedIn && /login|đăng nhập/i.test(text) && !/đã đăng nhập/i.test(text)) {
      loggedIn = true
      setTimeout(() => { try { bot.chat(`/login ${PASSWORD}`) } catch(e){} }, 2500)
    }
    if (/đăng nhập thành công/i.test(text)) { loggedIn = true; console.log('🔑 Đăng nhập thành công!') }
    if (/đăng ký thành công/i.test(text))   { registered = true; console.log('📝 Đăng ký thành công!') }
    if (/vui lòng.*discord|liên kết.*discord|link.*discord|discord.*để.*tiếp tục|bắt buộc.*discord/i.test(text)) {
      goIdle('Server yêu cầu link Discord, không thể tiếp tục')
    }
  }

  bot.on('chat', (username, message) => {
    if (username === USERNAME) return
    console.log(`💬 <${username}> ${message}`)
    handleMessage(message)
  })

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString()
    console.log(`💬 ${text}`)
    handleMessage(text)
  })

  bot.on('kicked', (reason) => {
    console.log('👢 Bị kick:', reason)
    if (/banned|ban|đã bị cấm/i.test(reason))          console.log('🚫 Bot có thể bị BAN!')
    if (/full|đầy server/i.test(reason))                console.log('🏠 Server đang đầy!')
    if (/afk|di chuyển|không hoạt động/i.test(reason)) console.log('🚶 Bị kick do AFK!')
    handleDisconnect('kicked')
  })

  bot.on('end',   (reason) => { console.log('🔌 Mất kết nối:', reason || ''); handleDisconnect('end') })
  bot.on('error', (err)    => { console.log('❌ Lỗi:', err?.message || err);  handleDisconnect('error') })
}

// ===== Console điều khiển =====
function showHelp() {
  console.log('───── 🛠️ LỆNH ĐIỀU KHIỂN ─────')
  console.log('help              - danh sách lệnh')
  console.log('status            - trạng thái bot')
  console.log('pos               - xem toạ độ hiện tại')
  console.log('say <tin nhắn>    - gửi chat')
  console.log('goto <x> <z>      - đi tới toạ độ, tự xây/lấp đường đi')
  console.log('stopwall          - dừng goto/xây giữa chừng')
  console.log('reconnect         - kết nối lại ngay')
  console.log('idle              - cho bot nghỉ')
  console.log('wake              - bật lại bot')
  console.log('<lệnh khác>       - gửi thẳng vào chat server (vd: /tpa Bu1039)')
  console.log('───────────────────────────────')
}

function showStatus() {
  console.log('───── 📋 TRẠNG THÁI BOT ─────')
  console.log(`🕐 Script chạy: ${formatDuration(Date.now() - scriptStartTime)}`)
  console.log(`💾 RAM: ${memUsageMB()} MB`)
  console.log(`🔁 Tổng reconnect: ${totalReconnects}`)
  if (shuttingDown) {
    console.log('💤 Đang NGHỈ. Gõ "wake" để bật lại.')
  } else if (bot && connectedSince) {
    const pos = bot.entity ? bot.entity.position : null
    console.log(`✅ Online: ${formatDuration(Date.now() - connectedSince)}`)
    console.log(`📍 Vị trí: ${pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : 'chưa rõ'}`)
    console.log(`📝 Registered: ${registered} | 🔑 LoggedIn: ${loggedIn}`)
    if (wallTask) console.log(`🚧 Đang goto (${wallTask.targetX}, ${wallTask.targetZ}) | Đã đặt: ${wallTask.placed} block`)
  } else if (nextReconnectAt) {
    const s = Math.max(0, Math.round((nextReconnectAt - Date.now()) / 1000))
    console.log(`⏳ Chờ kết nối lại sau ${s}s (lần ${reconnectAttempts})`)
  } else {
    console.log('🔌 Đang kết nối...')
  }
  console.log('─────────────────────────────')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const input = line.trim()
  if (!input) return
  const [cmd, ...rest] = input.split(' ')
  const arg = rest.join(' ')

  switch (cmd.toLowerCase()) {
    case 'help':   showHelp();   break
    case 'status': showStatus(); break
    case 'pos':
      if (!bot || !bot.entity) console.log('⚠️ Bot chưa sẵn sàng.')
      else { const p = bot.entity.position; console.log(`📍 ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`) }
      break
    case 'say':
    case 'chat':
      if (!arg) console.log('⚠️ Cú pháp: say <tin nhắn>')
      else if (shuttingDown || !bot) console.log('⚠️ Bot chưa kết nối hoặc đang nghỉ.')
      else { try { bot.chat(arg); console.log(`📤 Đã gửi: ${arg}`) } catch (e) { console.log('❌', e.message) } }
      break
    case 'goto': {
      const [x, z] = rest
      if (!x || !z) console.log('⚠️ Cú pháp: goto <x> <z>')
      else startGoto(x, z)
      break
    }
    case 'stopwall': stopWall('Lệnh từ console'); break
    case 'reconnect': forceReconnect(); break
    case 'idle':
    case 'pause':
      if (shuttingDown) console.log('ℹ️ Bot đã ở chế độ nghỉ.')
      else goIdle('Lệnh "idle" từ console')
      break
    case 'wake': wake(); break
    default:
      // Passthrough: gõ gì không khớp lệnh nội bộ thì gửi thẳng vào chat server
      // (vd: /tpa Bu1039, /tpahere, /home, ...)
      if (!bot || shuttingDown) {
        console.log(`❓ Không hiểu lệnh "${cmd}" và bot chưa kết nối nên không gửi được vào chat.`)
      } else {
        try { bot.chat(input); console.log(`📤 [passthrough] Đã gửi vào chat: ${input}`) }
        catch (e) { console.log('❌', e.message) }
      }
  }
})

process.on('uncaughtException',  (err)    => console.log('🆘 uncaughtException:', err?.message || err))
process.on('unhandledRejection', (reason) => console.log('🆘 unhandledRejection:', reason))

console.log('🚀 AFK Bot khởi động (Mineflayer)...')
console.log('💡 Gõ "help" để xem lệnh.')
acquireWakeLock()
scheduleAutoShutdown(5)
connect()
