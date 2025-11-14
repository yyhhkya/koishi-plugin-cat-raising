import { Context, Schema } from 'koishi'
import * as crypto from 'crypto'
import { URLSearchParams } from 'url'

export const name = 'cat-raising'

// --- 配置项定义 (Schema) ---

/** 监听群组的配置 */
export interface MonitorGroupConfig {
  /** 要监听的 QQ 群号 */
  groupId: string
  /** 是否在此群内发送“看到啦”之类的辅助/警告消息 */
  sendHelperMessages: boolean
}

/** 插件配置 */
export interface Config {
  /** 目标QQ号或QQ群号 */
  targetQQ: string
  /** 目标是否为QQ群 */
  isGroup: boolean
  /** 监听的群组列表及其配置 */
  monitorGroups: MonitorGroupConfig[]
  /** 用于防复读的历史记录大小 */
  historySize: number
  /** 用于发送B站弹幕的 access_key 列表 */
  biliAccessKeys: string[]
}

export const Config: Schema<Config> = Schema.object({
  targetQQ: Schema.string().description('目标QQ号或QQ群号').required(),
  isGroup: Schema.boolean().description('是否为QQ群').default(false),
  monitorGroups: Schema.array(Schema.object({
    groupId: Schema.string().description('要监听的 QQ 群号').required(),
    sendHelperMessages: Schema.boolean().description('是否在此群内发送“看到啦”之类的辅助/警告消息').default(true),
  }))
    .description('监听的群组列表及其配置')
    .required(),
  historySize: Schema.number()
    .description('用于防复读的历史记录大小，防止短期内对同一活动重复转发')
    .default(30)
    .min(5)
    .max(100),
  biliAccessKeys: Schema.array(Schema.string())
    .description('用于发送B站弹幕的 access_key 列表。插件会随机选择一个使用。如果留空，则不执行发送弹幕功能。')
    .default([]),
})

// --- 消息解析模块 ---

/**
 * 智能转换文本中的中文数字为阿拉伯数字。
 * @param text 包含中文数字的原始文本。
 * @returns 转换后的文本。
 */
function preprocessChineseNumerals(text: string): string {
  const numMap = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
  const unitMap = {
    '十': { value: 10, isSection: false },
    '百': { value: 100, isSection: false },
    '千': { value: 1000, isSection: false },
    '万': { value: 10000, isSection: true },
    '亿': { value: 100000000, isSection: true },
  }

  const chineseNumRegex = /([一二三四五六七八九十百千万亿两零]+)/g
  return text.replace(chineseNumRegex, (match) => {
    if (match.length === 1 && !numMap[match] && !unitMap[match]) return match

    let total = 0
    let sectionTotal = 0
    let currentNum = 0

    for (const char of match) {
      if (numMap[char] !== undefined) {
        currentNum = numMap[char]
      } else if (unitMap[char]) {
        const { value, isSection } = unitMap[char]
        if (value === 10 && currentNum === 0) currentNum = 1
        sectionTotal += currentNum * value
        currentNum = 0
        if (isSection) {
          total += sectionTotal
          sectionTotal = 0
        }
      }
    }
    total += sectionTotal + currentNum
    return String(total)
  })
}

/** 描述一项奖励的内容 */
interface Reward {
  /** 奖励数量 */
  amount: number
  /** 达成条件 */
  condition: string
}

/** 解析后的事件信息结构 */
interface ParsedEvent {
  /** 事件的日期和时间 */
  dateTime: string
  /** 事件包含的奖励列表 */
  rewards: Reward[]
}

/**
 * 从文本中提取所有可能是B站直播间的ID，并进行净化处理。
 * @param text 待查找的文本，可能包含CQ码。
 * @returns 一个包含所有不重复房间ID的字符串数组。
 */
function extractAllRoomIds(text: string): string[] {
  // 在匹配前先移除所有CQ码/HTML标签，防止其属性值（如 file-size）被误识别为房间号
  const sanitizedText = text.replace(/<[^>]+>/g, '')

  const patterns = [
    /(?:播间号|房间号|直播间)[:：\s]*(\d{3,15})/g,
    /\b(\d{6,15})\b/g, // 使用单词边界确保匹配的是独立数字
  ]
  const foundIds = new Set<string>()
  for (const pattern of patterns) {
    for (const match of sanitizedText.matchAll(pattern)) {
      if (match[1]) foundIds.add(match[1])
    }
  }
  return Array.from(foundIds)
}

/**
 * 从单行文本中寻找并格式化时间日期信息。
 * @param line 待解析的单行文本。
 * @returns 格式化后的时间字符串，或 null。
 */
function extractDateTime(line: string): string | null {
  let match: RegExpMatchArray
  if ((match = line.match(/(\d{1,2})\s*[月.]\s*(\d{1,2})\s*日?/))) return `${match[1]}月${match[2]}日`
  if ((match = line.match(/每晚\s*(\d{1,2})\s*[点时]/))) return `每晚 ${match[1].padStart(2, '0')}:00`
  if ((match = line.match(/(\d{1,2}\s*月\s*(?:上|中|下)旬)/))) return match[1]
  if ((match = line.match(/(\d{1,2})[:：.点时]\s*(\d{1,2})/))) return `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`
  if ((match = line.match(/(\d{1,2})\s*点\s*半/))) return `${match[1].padStart(2, '0')}:30`
  if ((match = line.match(/\b(\d{1,2})\s*[.点时](?!\d)/))) return `${match[1].padStart(2, '0')}:00`
  if ((match = line.match(/(\d{1,2})\s*分/))) {
    const now = new Date()
    const minuteVal = parseInt(match[1])
    const hourVal = now.getMinutes() > minuteVal ? now.getHours() + 1 : now.getHours()
    return `${(hourVal % 24).toString().padStart(2, '0')}:${match[1].padStart(2, '0')}`
  }
  if ((match = line.match(/.*?(?:生日|周年|新衣|活动).*/))) return match[0].trim()
  return null
}

/**
 * 从单行文本中解析奖励信息。
 * @param line 待解析的单行文本。
 * @returns 包含奖励信息的对象数组。
 */
function extractRewards(line: string): Reward[] {
  const rewards: Reward[] = []
  const regex = /(?:(\d{1,2})\s*级(?:灯牌)?\s*)?(?:发\s*)?(\d+\.?\d*w\+?|\b\d{3,5}\b)(?:神金|钻石|猫猫钻)?/gi
  let match: RegExpExecArray
  while ((match = regex.exec(line)) !== null) {
    const condition = match[1] ? `${match[1]}级灯牌` : '无限制'
    const amountStr = (match[2] || '').toLowerCase()
    const amount = amountStr.includes('w') ? parseFloat(amountStr.replace('w', '')) * 10000 : parseFloat(amountStr)
    if (!isNaN(amount) && amount > 0) {
      rewards.push({ amount, condition })
    }
  }
  return rewards
}

/**
 * 整合解析流程，将完整消息文本转换为结构化的事件数据。
 * @param text 完整的消息内容。
 * @returns 包含解析后事件的对象，若无有效信息则返回 null。
 */
function parseEventFromText(text: string): ParsedEvent | null {
  const lines = text.split('\n').filter(line => line.trim())
  let globalDateTime: string | null = null
  for (const line of lines) {
    const timeInLine = extractDateTime(line)
    if (timeInLine) {
      globalDateTime = timeInLine
      break
    }
  }
  const allRewards = lines.flatMap(line => extractRewards(line))
  return allRewards.length > 0 ? { dateTime: globalDateTime || '时间未知', rewards: allRewards } : null
}

// --- 插件主逻辑 ---

/** 存储已转发消息的条目，用于防复读和撤回联动 */
interface ForwardedEntry {
  /** 源消息 ID */
  originalMessageId: string
  /** 转发后的消息 ID */
  forwardedMessageId: string
  /** 机器人发送的辅助消息 ID (可选) */
  helperMessageId?: string
  /** 关联的直播间房号 */
  roomId: string
  /** 事件时间 */
  dateTime: string
}

/** 从 Bilibili API 获取的直播间关联信息 */
interface BiliInfo {
  /** 主播的视频投稿总数 */
  videoCount: number
}

// --- 常量定义 ---

/** 包含这些关键词的消息将被直接拒绝，不进行后续处理 */
const HARD_REJECTION_KEYWORDS = ['发言榜单', '投稿数:']
/** 包含这些关键词但没有覆盖关键词的消息将被拒绝 */
const REJECTION_KEYWORDS = ['签到', '打卡']
/** 如果消息中包含这些关键词，可以覆盖 REJECTION_KEYWORDS 的限制 */
const OVERRIDE_KEYWORDS = ['神金', '发']
/** 用于初步筛选消息的触发词正则表达式 */
const TRIGGER_REGEX = /神金|发|掉落|猫猫钻|w|\b\d{3,5}\b|一千|一百|十|九|八|七|六|五|四|三|两|二|一/i

/** Bilibili 开放平台 App Key */
const BILI_APPKEY = '4409e2ce8ffd12b8'
/** Bilibili 开放平台 App Secret */
const BILI_APPSECRET = '59b43e04ad6965f34319062b478f83dd'

// --- Bilibili API 模块 ---

/**
 * 为 Bilibili API 请求参数进行签名 (md5)。
 * @param params 未签名的请求参数对象。
 * @param appSecret App Secret.
 * @returns 携带签名的完整请求参数。
 */
function signBilibiliParams(params: Record<string, any>, appSecret: string): string {
  const sortedKeys = Object.keys(params).sort()
  const queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&')
  const sign = crypto.createHash('md5').update(queryString + appSecret).digest('hex')
  return sign
}

/**
 * 向指定的B站直播间发送弹幕。
 * @param ctx Koishi 上下文。
 * @param config 插件配置。
 * @param roomId 直播间真实 ID。
 * @param message 要发送的弹幕内容。
 */
async function sendBilibiliDanmaku(ctx: Context, config: Config, roomId: string, message: string): Promise<void> {
  if (!config.biliAccessKeys || config.biliAccessKeys.length === 0) {
    ctx.logger.info('[弹幕] 未配置 access_key，跳过发送弹幕。')
    return
  }

  // 随机选择一个 access_key 使用
  const accessKey = config.biliAccessKeys[Math.floor(Math.random() * config.biliAccessKeys.length)]

  const url = 'https://api.live.bilibili.com/xlive/app-room/v1/dM/sendmsg'
  const ts = Math.floor(Date.now() / 1000)

  const baseParams = {
    access_key: accessKey,
    actionKey: 'appkey',
    appkey: BILI_APPKEY,
    cid: roomId,
    msg: message,
    rnd: ts,
    color: '16777215', // 白色
    fontsize: '25',
    mode: '1', // 滚动弹幕
    ts: ts,
  }

  const sign = signBilibiliParams(baseParams, BILI_APPSECRET)
  const params = { ...baseParams, sign }
  const formData = new URLSearchParams()
  for (const key in params) {
    formData.append(key, params[key])
  }

  try {
    const response = await ctx.http.post(url, formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 BiliDroid/6.73.1 (bbcallen@gmail.com) os/android model/Mi 10 Pro mobi_app/android build/6731100 channel/xiaomi innerVer/6731110 osVer/12 network/2',
      },
    })

    if (response.code === 0) {
      ctx.logger.info(`[弹幕] 成功向直播间 ${roomId} 发送弹幕: "${message}"`)
    } else {
      ctx.logger.warn(`[弹幕] 发送失败，直播间 ${roomId}。原因: ${response.message || '未知错误'}`)
    }
  } catch (error) {
    ctx.logger.error(`[弹幕] 发送请求时发生网络错误，直播间 ${roomId}:`, error)
  }
}

/**
 * 异步获取B站直播间关联的用户信息（如投稿数）。
 * @param ctx Koishi 上下文。
 * @param roomId 直播间ID。
 * @returns 包含用户信息的对象，失败则返回 null。
 */
async function fetchBilibiliInfo(ctx: Context, roomId: string): Promise<BiliInfo | null> {
  try {
    const roomInfo = await ctx.http.get(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`)
    const uid = roomInfo?.data?.uid
    if (!uid) throw new Error('无法从房间信息中获取UID')

    const statsInfo = await ctx.http.get(`https://api.bilibili.com/x/space/navnum?mid=${uid}`)
    const videoCount = statsInfo?.data?.video
    if (videoCount === undefined) throw new Error('无法从空间信息中获取投稿数')

    return { videoCount }
  } catch (error) {
    ctx.logger.warn(`[API] 获取直播间 ${roomId} 的B站信息失败: ${error.message}`)
    return null
  }
}

/**
 * 插件的主应用函数。
 * @param ctx Koishi 上下文。
 * @param config 插件配置。
 */
export function apply(ctx: Context, config: Config) {
  const forwardedHistory: ForwardedEntry[] = []
  const warningMessageMap = new Map<string, string>()

  // --- 消息监听与处理 ---
  ctx.on('message', async (session) => {
    // 1. 初步过滤 (Guards)
    const groupConfig = config.monitorGroups.find(g => g.groupId === session.channelId)
    if (!groupConfig) return // 非监听群组的消息，直接忽略

    const strippedContent = session.stripped.content
    if (!strippedContent.trim()) return // 忽略纯图片、表情等无文本消息

    if (HARD_REJECTION_KEYWORDS.some(keyword => strippedContent.includes(keyword))) return
    if (!TRIGGER_REGEX.test(strippedContent)) return

    // 2. 核心信息提取与验证
    const roomIds = extractAllRoomIds(session.content)
    if (roomIds.length !== 1) { // 只处理包含唯一房号的消息
      if (roomIds.length > 1) ctx.logger.info(`[忽略] 消息包含多个房间号: ${roomIds.join(', ')}`)
      return
    }
    const roomId = roomIds[0]

    const preprocessedMessage = preprocessChineseNumerals(strippedContent)
    const hasRejectionKeyword = REJECTION_KEYWORDS.some(keyword => preprocessedMessage.includes(keyword))
    if (hasRejectionKeyword && !OVERRIDE_KEYWORDS.some(keyword => preprocessedMessage.includes(keyword))) return

    const parsedEvent = parseEventFromText(preprocessedMessage)
    if (!parsedEvent) return // 未解析出任何有效奖励信息

    const hasStrongContext = /神金|发|w/i.test(preprocessedMessage)
    const hasTime = parsedEvent.dateTime !== '时间未知'
    if (!hasStrongContext && !hasTime) return // 缺乏强上下文（如“神金”）且没有时间信息，可能为误判

    // 3. 防复读检查
    const { dateTime } = parsedEvent
    if (forwardedHistory.some(entry => entry.roomId === roomId && entry.dateTime === dateTime)) {
      ctx.logger.info(`[防复读] 检测到重复活动: 房间=${roomId}, 时间=${dateTime}`)
      if (groupConfig.sendHelperMessages) { // 根据群组配置决定是否发送警告消息
        try {
          const [warningId] = await session.send(`看到啦看到啦，不要发那么多次嘛~`)
          if (warningId) warningMessageMap.set(session.messageId, warningId)
        } catch (e) {
          ctx.logger.warn('[消息] 发送重复警告失败:', e)
        }
      }
      return
    }

    // 4. 获取外部信息
    const biliInfo = await fetchBilibiliInfo(ctx, roomId)
    if (!biliInfo) return // API 获取失败则不转发

    // 根据群组配置决定是否发送B站信息作为辅助消息
    let helperMessageId: string | undefined
    if (groupConfig.sendHelperMessages) {
      [helperMessageId] = await session.send(`直播间: ${roomId}\n投稿数: ${biliInfo.videoCount}`)
    }

    // 5. 转发并记录
    try {
      const forwardMessage = `${session.content}\n\n---\n投稿数: ${biliInfo.videoCount}`
      const [forwardedMessageId] = config.isGroup
        ? await session.bot.sendMessage(config.targetQQ, forwardMessage)
        : await session.bot.sendPrivateMessage(config.targetQQ, forwardMessage)

      // 记录转发历史
      forwardedHistory.push({
        originalMessageId: session.messageId,
        forwardedMessageId,
        helperMessageId, // helperMessageId 可能是 undefined
        roomId,
        dateTime,
      })
      if (forwardedHistory.length > config.historySize) forwardedHistory.shift()

      // 成功转发后，尝试发送弹幕
      await sendBilibiliDanmaku(ctx, config, roomId, '喵喵喵')

    } catch (error) {
      session.send('🐱 - 转发失败，请检查目标QQ/群号配置是否正确')
      ctx.logger.error('[转发] 失败:', error)
    }
  })

  // --- 消息撤回处理 ---
  ctx.on('message-deleted', async (session) => {
    // 确保只处理受监控群的撤回事件
    const isMonitored = config.monitorGroups.some(g => g.groupId === session.channelId)
    if (!isMonitored) return

    const originalMessageId = session.messageId

    // Case 1: 撤回的是被转发过的源消息
    const entryIndex = forwardedHistory.findIndex(entry => entry.originalMessageId === originalMessageId)
    if (entryIndex !== -1) {
      const entry = forwardedHistory[entryIndex]
      // 联动撤回机器人发送的辅助消息
      if (entry.helperMessageId) {
        try { await session.bot.deleteMessage(session.channelId, entry.helperMessageId) }
        catch (e) { ctx.logger.warn(`[撤回] 助手消息 (ID: ${entry.helperMessageId}) 失败:`, e) }
      }
      // 联动撤回已转发到目标的消息
      try { await session.bot.deleteMessage(config.targetQQ, entry.forwardedMessageId) }
      catch (e) { ctx.logger.warn(`[撤回] 转发消息 (ID: ${entry.forwardedMessageId}) 失败:`, e) }
      finally {
        forwardedHistory.splice(entryIndex, 1) // 从历史记录中移除
        ctx.logger.info(`[撤回] 已联动撤回与源消息 ${originalMessageId} 相关的转发。`)
      }
    }

    // Case 2: 撤回的是触发了防复读警告的消息
    if (warningMessageMap.has(originalMessageId)) {
      const warningMessageId = warningMessageMap.get(originalMessageId)
      try { await session.bot.deleteMessage(session.channelId, warningMessageId) }
      catch (e) { ctx.logger.warn(`[撤回] 警告消息 (ID: ${warningMessageId}) 失败:`, e) }
      finally {
        warningMessageMap.delete(originalMessageId)
        ctx.logger.info(`[撤回] 已联动撤回与源消息 ${originalMessageId} 相关的警告。`)
      }
    }
  })
}
